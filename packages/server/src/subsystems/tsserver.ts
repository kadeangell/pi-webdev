/**
 * TypeScript LSP — spawns `tsserver` and translates its JSON-line protocol
 * into WDP `types.*` methods.
 *
 * Why tsserver and not the LSP server-mode-of-tsc: tsserver's protocol is
 * narrower and stable, and it's the same engine VSCode uses. We pay for one
 * subprocess and a thin client.
 *
 * v0 implements diagnostics + hoverInfo + definition + references. Streaming
 * `types.diagnostics_changed` events fire when geterr completes for a file.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ErrorCodes,
  WdpError,
  type TypeDiagnostic,
  type TypesDefinitionParams,
  type TypesDefinitionResult,
  type TypesDiagnosticsParams,
  type TypesDiagnosticsResult,
  type TypesHoverInfoParams,
  type TypesHoverInfoResult,
  type TypesReferencesParams,
  type TypesReferencesResult,
} from "@pi-webdev/shared-types";
import type { Subsystem } from "./registry.js";
import type { Dispatcher } from "../dispatcher.js";

interface TsRequest {
  seq: number;
  type: "request";
  command: string;
  arguments?: unknown;
}

interface TsResponse {
  seq: number;
  type: "response";
  request_seq: number;
  command: string;
  success: boolean;
  body?: unknown;
  message?: string;
}

interface TsEvent {
  seq: number;
  type: "event";
  event: string;
  body?: unknown;
}

interface Pending {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface TsServerSubsystemOptions {
  /** Path to the tsserver script. Defaults to the workspace-resolved typescript. */
  tsserverPath?: string;
  /** Project root used to resolve relative file paths. */
  projectRoot: string;
}

export class TsServerSubsystem implements Subsystem {
  readonly name = "tsserver";
  readonly events = new EventEmitter();
  private child: ChildProcess | null = null;
  private nextSeq = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  /** Files we've sent an `open` for; tsserver requires open before geterr/etc. */
  private opened = new Set<string>();
  /** Last-known diagnostics per file — keyed by absolute path. */
  private diagnosticsByFile = new Map<string, TypeDiagnostic[]>();
  /** Inflight geterr completions, awaited by `types.diagnostics`. */
  private geterrWaiters = new Map<number, () => void>();
  private geterrSeq = 0;

  constructor(private readonly opts: TsServerSubsystemOptions) {}

  async start(): Promise<void> {
    const tsserver = this.opts.tsserverPath ?? this.resolveTsserver();
    if (!tsserver) throw new Error("tsserver script not found");
    // tsserver is a Node script — spawn it via node so we don't depend on a shebang.
    this.child = spawn(process.execPath, [tsserver, "--useSingleInferredProject"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.projectRoot,
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.once("exit", () => {
      this.child = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("tsserver exited"));
      }
      this.pending.clear();
    });

    // tsserver needs no formal handshake; a simple `configure` call confirms responsiveness.
    await this.request("configure", { preferences: { includePackageJsonAutoImports: "off" } });
  }

  async stop(): Promise<void> {
    if (this.child) {
      const child = this.child;
      this.child = null;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      await waitForExit(child, 2000);
    }
    this.opened.clear();
    this.diagnosticsByFile.clear();
  }

  heartbeat(): boolean {
    return this.child !== null && !this.child.killed;
  }

  async openFile(absPath: string): Promise<void> {
    if (this.opened.has(absPath)) return;
    await this.request("open", { file: absPath });
    this.opened.add(absPath);
  }

  async diagnostics(params: TypesDiagnosticsParams = {}): Promise<TypesDiagnosticsResult> {
    if (!this.child) throw new WdpError(ErrorCodes.SubsystemNotReady, "tsserver not ready");
    const files = (params.files ?? [...this.opened])
      .map((f) => path.isAbsolute(f) ? f : path.resolve(this.opts.projectRoot, f));
    for (const f of files) await this.openFile(f);
    if (files.length === 0) return { diagnostics: [] };

    // tsserver's `geterr` is async — it streams diagnostics events and completes with `requestCompleted`.
    const seq = ++this.geterrSeq;
    const done = new Promise<void>((resolve) => {
      this.geterrWaiters.set(seq, resolve);
    });
    // Use a notification-style send (no response correlation) to avoid timeouts; we drive completion via the event.
    this.sendRaw({ seq: this.nextSeq++, type: "request", command: "geterr", arguments: { files, delay: 0 } });
    await Promise.race([done, sleep(5000)]);
    this.geterrWaiters.delete(seq);

    const scope = params.scope ?? "all";
    let collected: TypeDiagnostic[] = [];
    for (const f of files) {
      const list = this.diagnosticsByFile.get(f) ?? [];
      for (const d of list) {
        if (scope !== "all" && d.category !== scope) continue;
        collected.push({ ...d, file: path.relative(this.opts.projectRoot, d.file) });
      }
    }
    return { diagnostics: collected };
  }

  async hoverInfo(params: TypesHoverInfoParams): Promise<TypesHoverInfoResult> {
    const abs = this.absFile(params.file);
    await this.openFile(abs);
    const body = await this.request<{
      displayString?: string;
      documentation?: string;
      start: { line: number; offset: number };
      end: { line: number; offset: number };
    }>("quickinfo", { file: abs, line: params.line, offset: params.offset });
    if (!body) return { contents: "" };
    return {
      contents: body.displayString ?? "",
      ...(body.documentation ? { documentation: body.documentation } : {}),
      ...(body.start ? { range: { start: body.start, end: body.end } } : {}),
    };
  }

  async definition(params: TypesDefinitionParams): Promise<TypesDefinitionResult> {
    const abs = this.absFile(params.file);
    await this.openFile(abs);
    const body = await this.request<Array<{ file: string; start: { line: number; offset: number }; end: { line: number; offset: number } }>>(
      "definition", { file: abs, line: params.line, offset: params.offset },
    );
    return {
      locations: (body ?? []).map((l) => ({
        file: path.relative(this.opts.projectRoot, l.file),
        start: l.start,
        end: l.end,
      })),
    };
  }

  async references(params: TypesReferencesParams): Promise<TypesReferencesResult> {
    const abs = this.absFile(params.file);
    await this.openFile(abs);
    const body = await this.request<{ refs?: Array<{ file: string; start: { line: number; offset: number }; end: { line: number; offset: number } }> }>(
      "references", { file: abs, line: params.line, offset: params.offset },
    );
    return {
      locations: (body?.refs ?? []).map((l) => ({
        file: path.relative(this.opts.projectRoot, l.file),
        start: l.start,
        end: l.end,
      })),
    };
  }

  private absFile(file: string): string {
    return path.isAbsolute(file) ? file : path.resolve(this.opts.projectRoot, file);
  }

  private async request<R = unknown>(command: string, args?: unknown, timeoutMs = 4000): Promise<R> {
    if (!this.child) throw new WdpError(ErrorCodes.SubsystemNotReady, "tsserver not ready");
    const seq = this.nextSeq++;
    const body: TsRequest = { seq, type: "request", command, ...(args !== undefined ? { arguments: args } : {}) };
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(seq)) return;
        this.pending.delete(seq);
        reject(new Error(`tsserver ${command} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(seq, { resolve: resolve as Pending["resolve"], reject, timer });
      this.sendRaw(body);
    });
  }

  private sendRaw(payload: TsRequest): void {
    if (!this.child) return;
    this.child.stdin!.write(JSON.stringify(payload) + "\n");
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line || !line.startsWith("{")) continue; // tsserver also emits Content-Length headers we don't need
      this.onMessage(line);
    }
  }

  private onMessage(line: string): void {
    let msg: TsResponse | TsEvent;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "response") {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      clearTimeout(p.timer);
      if (msg.success) p.resolve(msg.body);
      else p.reject(new Error(`tsserver ${msg.command} failed: ${msg.message ?? "unknown"}`));
    } else if (msg.type === "event") {
      this.handleEvent(msg);
    }
  }

  private handleEvent(ev: TsEvent): void {
    if (ev.event === "syntaxDiag" || ev.event === "semanticDiag" || ev.event === "suggestionDiag") {
      const body = ev.body as { file: string; diagnostics: Array<{ start: { line: number; offset: number }; end: { line: number; offset: number }; text: string; category: TypeDiagnostic["category"]; code: number }> } | undefined;
      if (!body) return;
      const source = ev.event === "syntaxDiag" ? "syntax" : ev.event === "semanticDiag" ? "semantic" : "suggestion";
      const existing = this.diagnosticsByFile.get(body.file) ?? [];
      // Merge: replace diagnostics from this source, keep others.
      const filtered = existing.filter((d) => d.source !== source);
      const next = filtered.concat(body.diagnostics.map((d) => ({
        file: body.file,
        start: d.start,
        end: d.end,
        text: d.text,
        category: d.category,
        code: d.code,
        source,
      })));
      this.diagnosticsByFile.set(body.file, next);
      this.events.emit("diagnostics", {
        file: path.relative(this.opts.projectRoot, body.file),
        diagnostics: next.map((d) => ({ ...d, file: path.relative(this.opts.projectRoot, d.file) })),
      });
    } else if (ev.event === "requestCompleted") {
      // Mark any waiting geterr as finished.
      for (const [seq, resolve] of this.geterrWaiters) {
        resolve();
        this.geterrWaiters.delete(seq);
        break;
      }
    }
  }

  private resolveTsserver(): string | null {
    const local = path.join(this.opts.projectRoot, "node_modules", "typescript", "lib", "tsserver.js");
    if (existsSync(local)) return local;
    try {
      return localRequire.resolve("typescript/lib/tsserver.js");
    } catch {
      return null;
    }
  }
}

import { createRequire } from "node:module";
const localRequire = createRequire(import.meta.url);

export function registerTsServerSubsystem(dispatcher: Dispatcher, ts: TsServerSubsystem): void {
  dispatcher.register<TypesDiagnosticsParams, TypesDiagnosticsResult>(
    "types.diagnostics", (p) => ts.diagnostics(p ?? {}),
  );
  dispatcher.register<TypesHoverInfoParams, TypesHoverInfoResult>(
    "types.hoverInfo", (p) => ts.hoverInfo(p),
  );
  dispatcher.register<TypesDefinitionParams, TypesDefinitionResult>(
    "types.definition", (p) => ts.definition(p),
  );
  dispatcher.register<TypesReferencesParams, TypesReferencesResult>(
    "types.references", (p) => ts.references(p),
  );
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      resolve();
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
