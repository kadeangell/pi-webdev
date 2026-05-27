import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createTcpProbe } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ErrorCodes,
  WdpError,
  type BrowserClickParams,
  type BrowserClickResult,
  type BrowserConsoleEntry,
  type BrowserConsoleParams,
  type BrowserConsoleResult,
  type BrowserDomParams,
  type BrowserDomResult,
  type BrowserEvalParams,
  type BrowserEvalResult,
  type BrowserFillParams,
  type BrowserFillResult,
  type BrowserNavigateParams,
  type BrowserNavigateResult,
  type InspectComponentByQueryParams,
  type InspectComponentByQueryResult,
  type InspectComponentTreeParams,
  type InspectComponentTreeResult,
  type InspectPropsParams,
  type InspectPropsResult,
  type InspectStateParams,
  type InspectStateResult,
  type SessionCloseParams,
  type SessionCloseResult,
  type SessionCreateParams,
  type SessionCreateResult,
  type SessionListResult,
} from "@pi-webdev/shared-types";
import type { Subsystem } from "../registry.js";
import type { Dispatcher } from "../../dispatcher.js";
import { CdpClient } from "./cdp-client.js";
import { INSPECT_INJECTION_SCRIPT } from "./inspect-script.js";

const DEFAULT_BINARY = "lightpanda";
const MAX_CONSOLE_ENTRIES = 500;

interface BrowserSession {
  /** WDP-facing id. */
  id: string;
  /** CDP target id. */
  targetId: string;
  /** CDP session id from Target.attachToTarget(flatten:true). */
  cdpSessionId: string;
  /** Last navigated URL we observed. */
  url?: string;
  /** Ring-buffered console entries from Runtime.consoleAPICalled. */
  console: BrowserConsoleEntry[];
  /** Has Page.addScriptToEvaluateOnNewDocument fired for this session? */
  inspectorInstalled?: boolean;
}

export interface BrowserSubsystemOptions {
  /** Path to the lightpanda binary. Defaults to "lightpanda" in PATH. */
  binary?: string;
  /** Extra args appended after `serve --port <p>`. */
  extraArgs?: string[];
  /** Bind host for the embedded CDP server. Defaults to 127.0.0.1. */
  host?: string;
  /** Bind port. Defaults to 0 (let the OS pick). */
  port?: number;
  /** Wait this long for /json/version before declaring start() failed. */
  startupTimeoutMs?: number;
}

/**
 * Spawns Lightpanda (CDP-over-WebSocket) as a child process and exposes
 * an LLM-shaped browser surface on top of it. First subprocess subsystem;
 * stresses the registry's lifecycle hooks for real.
 */
export class BrowserSubsystem implements Subsystem {
  readonly name = "browser";
  private child: ChildProcess | null = null;
  private cdp: CdpClient | null = null;
  private port = 0;
  private nextSessionN = 1;
  private sessions = new Map<string, BrowserSession>();
  private sessionByCdpId = new Map<string, BrowserSession>();
  /** Per-target navigation barriers — resolved when Page.loadEventFired fires. */
  private loadBarriers = new Map<string, () => void>();

  private readonly opts: Required<Omit<BrowserSubsystemOptions, "extraArgs">> & { extraArgs: string[] };

  constructor(opts: BrowserSubsystemOptions = {}) {
    this.opts = {
      binary: opts.binary ?? DEFAULT_BINARY,
      extraArgs: opts.extraArgs ?? [],
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 0,
      startupTimeoutMs: opts.startupTimeoutMs ?? 8000,
    };
  }

  async start(): Promise<void> {
    this.port = this.opts.port === 0 ? await pickFreePort() : this.opts.port;
    const args = ["serve", "--host", this.opts.host, "--port", String(this.port), ...this.opts.extraArgs];
    this.child = spawn(this.opts.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child.once("exit", (code, signal) => {
      // Surfacing via heartbeat-returns-false is enough for the registry to mark crashed.
      this.child = null;
      void code; void signal;
    });

    await this.waitForReady();
    this.cdp = await CdpClient.connect(`ws://${this.opts.host}:${this.port}/`);

    // Console + navigation event wiring.
    this.cdp.on("Runtime.consoleAPICalled", (params, cdpSessionId) => {
      const sess = cdpSessionId ? this.sessionByCdpId.get(cdpSessionId) : undefined;
      if (!sess) return;
      const text = (params?.args ?? [])
        .map((a: any) => (a?.value !== undefined ? String(a.value) : a?.description ?? ""))
        .join(" ");
      sess.console.push({
        level: (params?.type ?? "log") as BrowserConsoleEntry["level"],
        text,
        timestamp: new Date().toISOString(),
      });
      if (sess.console.length > MAX_CONSOLE_ENTRIES) sess.console.shift();
    });
    this.cdp.on("Page.frameNavigated", (params, cdpSessionId) => {
      const sess = cdpSessionId ? this.sessionByCdpId.get(cdpSessionId) : undefined;
      if (!sess) return;
      if (params?.frame?.parentId == null) sess.url = params?.frame?.url;
    });
    this.cdp.on("Page.loadEventFired", (_params, cdpSessionId) => {
      if (!cdpSessionId) return;
      const fire = this.loadBarriers.get(cdpSessionId);
      if (fire) {
        this.loadBarriers.delete(cdpSessionId);
        fire();
      }
    });
  }

  async stop(): Promise<void> {
    this.sessions.clear();
    this.sessionByCdpId.clear();
    if (this.cdp) {
      await this.cdp.close().catch(() => undefined);
      this.cdp = null;
    }
    if (this.child) {
      const child = this.child;
      this.child = null;
      child.kill("SIGTERM");
      await waitForExit(child, 2000);
    }
  }

  heartbeat(): boolean {
    return this.child !== null && !!this.cdp && this.cdp.isOpen();
  }

  async createSession(params: SessionCreateParams = {}): Promise<SessionCreateResult> {
    const cdp = this.cdp;
    if (!cdp) throw new WdpError(ErrorCodes.SubsystemNotReady, "browser not ready");
    // Lightpanda rejects subsequent Target.createTarget with about:blank as
    // TargetAlreadyLoaded. Pass an empty url and navigate explicitly.
    const { targetId } = await cdp.call<{ targetId: string }>("Target.createTarget", { url: "" });
    const { sessionId: cdpSessionId } = await cdp.call<{ sessionId: string }>(
      "Target.attachToTarget", { targetId, flatten: true },
    );
    await cdp.call("Page.enable", {}, cdpSessionId);
    await cdp.call("Runtime.enable", {}, cdpSessionId);

    const id = `b${this.nextSessionN++}`;
    const sess: BrowserSession = { id, targetId, cdpSessionId, console: [] };
    this.sessions.set(id, sess);
    this.sessionByCdpId.set(cdpSessionId, sess);

    if (params.url) {
      await this.navigateInternal(sess, params.url, "load");
    } else {
      // Even on about:blank, install the inspector so it's present before
      // a future navigation; React's hook is read at module-init time.
      await this.installInspector(sess).catch(() => undefined);
    }
    return { sessionId: id };
  }

  listSessions(): SessionListResult {
    return {
      sessions: [...this.sessions.values()].map((s) => ({
        sessionId: s.id,
        ...(s.url !== undefined ? { url: s.url } : {}),
      })),
    };
  }

  async closeSession(params: SessionCloseParams): Promise<SessionCloseResult> {
    const sess = this.sessions.get(params.sessionId);
    if (!sess) return { closed: false };
    try {
      await this.cdp?.call("Target.closeTarget", { targetId: sess.targetId });
    } catch {
      // best-effort; target may already be gone
    }
    this.sessions.delete(sess.id);
    this.sessionByCdpId.delete(sess.cdpSessionId);
    return { closed: true };
  }

  async navigate(params: BrowserNavigateParams): Promise<BrowserNavigateResult> {
    const sess = this.requireSession(params.sessionId);
    return this.navigateInternal(sess, params.url, params.waitFor ?? "load");
  }

  private async navigateInternal(
    sess: BrowserSession,
    url: string,
    waitFor: "navigation" | "load" | "domContentLoaded",
  ): Promise<BrowserNavigateResult> {
    const cdp = this.requireCdp();
    const loadPromise = waitFor === "load"
      ? new Promise<void>((resolve) => this.loadBarriers.set(sess.cdpSessionId, resolve))
      : null;
    const r = await cdp.call<{ loaderId?: string; frameId?: string; errorText?: string }>(
      "Page.navigate", { url }, sess.cdpSessionId,
    );
    if (r.errorText) throw new WdpError(ErrorCodes.ToolError, `navigation failed: ${r.errorText}`);
    if (loadPromise) {
      await Promise.race([loadPromise, sleep(5000)]);
      this.loadBarriers.delete(sess.cdpSessionId);
    }
    sess.url = url;
    // Re-install the inspector after the new document loads — the previous
    // page's __piWebdev is gone.
    await this.installInspector(sess).catch(() => undefined);
    const result: BrowserNavigateResult = { url };
    if (r.loaderId !== undefined) result.loaderId = r.loaderId;
    if (r.frameId !== undefined) result.frameId = r.frameId;
    return result;
  }

  /**
   * Register the inspector to run before every new document via CDP
   * `Page.addScriptToEvaluateOnNewDocument`, and also fire-and-forget eval
   * it against the current document so callers that don't navigate (or that
   * race the load event) still end up with `window.__piWebdev` available.
   *
   * Installing before navigation is critical for React: React reads
   * `__REACT_DEVTOOLS_GLOBAL_HOOK__` at module-init time. If our hook
   * isn't already on `window` when React's bundle evaluates, we never see
   * `onCommitFiberRoot` calls and the component tree stays empty.
   */
  private async installInspector(sess: BrowserSession): Promise<void> {
    const cdp = this.requireCdp();
    if (!sess.inspectorInstalled) {
      await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
        source: INSPECT_INJECTION_SCRIPT,
      }, sess.cdpSessionId).catch(() => undefined);
      sess.inspectorInstalled = true;
    }
    await cdp.call("Runtime.evaluate", {
      expression: INSPECT_INJECTION_SCRIPT,
      returnByValue: true,
    }, sess.cdpSessionId).catch(() => undefined);
  }

  async componentTree(params: InspectComponentTreeParams): Promise<InspectComponentTreeResult> {
    const sess = this.requireSession(params.sessionId);
    const r = (await this.evalRaw(sess, "window.__piWebdev ? window.__piWebdev.tree() : { unavailable: true, roots: [] }")) as InspectComponentTreeResult | undefined;
    return r ?? { unavailable: true, roots: [] };
  }

  async componentByQuery(params: InspectComponentByQueryParams): Promise<InspectComponentByQueryResult> {
    const sess = this.requireSession(params.sessionId);
    const r = (await this.evalRaw(sess, `window.__piWebdev ? window.__piWebdev.query(${JSON.stringify(params.query)}) : { matches: [] }`)) as InspectComponentByQueryResult | undefined;
    return r ?? { matches: [] };
  }

  async inspectProps(params: InspectPropsParams): Promise<InspectPropsResult> {
    const sess = this.requireSession(params.sessionId);
    const r = (await this.evalRaw(sess, `window.__piWebdev ? window.__piWebdev.props(${JSON.stringify(params.componentId)}) : { error: 'inspector not installed' }`)) as { props?: Record<string, unknown>; error?: string };
    if (r?.error) throw new WdpError(ErrorCodes.NotFound, r.error);
    return { props: r?.props ?? {} };
  }

  async inspectState(params: InspectStateParams): Promise<InspectStateResult> {
    const sess = this.requireSession(params.sessionId);
    const r = (await this.evalRaw(sess, `window.__piWebdev ? window.__piWebdev.state(${JSON.stringify(params.componentId)}) : { error: 'inspector not installed' }`)) as { state?: Record<string, unknown> | null; hooks?: Array<{ index: number; value: unknown }>; error?: string };
    if (r?.error) throw new WdpError(ErrorCodes.NotFound, r.error);
    return { state: r?.state ?? null, hooks: r?.hooks ?? [] };
  }

  async dom(params: BrowserDomParams): Promise<BrowserDomResult> {
    const sess = this.requireSession(params.sessionId);
    const mode = params.mode ?? "text";
    const scope = params.selector
      ? `document.querySelector(${JSON.stringify(params.selector)})`
      : "document.documentElement";
    if (mode === "text") {
      const r = await this.evalRaw(sess, `(() => { const el = ${scope}; return el ? (el.innerText ?? el.textContent ?? '') : ''; })()`);
      return { mode, text: (r as string) ?? "" };
    }
    if (mode === "html") {
      const r = await this.evalRaw(sess, `(() => { const el = ${scope}; return el ? el.outerHTML : ''; })()`);
      return { mode, html: (r as string) ?? "" };
    }
    // aria — try Accessibility.getFullAXTree; fall back to text.
    try {
      const tree = await this.requireCdp().call("Accessibility.getFullAXTree", {}, sess.cdpSessionId);
      return { mode: "aria", tree };
    } catch {
      const r = await this.evalRaw(sess, `(() => { const el = ${scope}; return el ? (el.innerText ?? el.textContent ?? '') : ''; })()`);
      return { mode: "aria", text: (r as string) ?? "" };
    }
  }

  async eval(params: BrowserEvalParams): Promise<BrowserEvalResult> {
    const sess = this.requireSession(params.sessionId);
    if (typeof params.expression !== "string") {
      throw new WdpError(ErrorCodes.InvalidParams, "browser.eval requires expression: string");
    }
    const cdp = this.requireCdp();
    const r = await cdp.call<{
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression: params.expression,
      returnByValue: true,
      awaitPromise: params.awaitPromise !== false,
    }, sess.cdpSessionId);
    if (r.exceptionDetails) {
      const message = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation failed";
      return { exception: { message } };
    }
    return { result: r.result?.value };
  }

  async click(params: BrowserClickParams): Promise<BrowserClickResult> {
    const sess = this.requireSession(params.sessionId);
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(params.selector)});
      if (!el) return { ok: false };
      el.click();
      return { ok: true };
    })()`;
    const r = (await this.evalRaw(sess, expr)) as { ok: boolean } | undefined;
    if (!r?.ok) throw new WdpError(ErrorCodes.NotFound, `selector not found: ${params.selector}`);
    return { dispatched: true };
  }

  async fill(params: BrowserFillParams): Promise<BrowserFillResult> {
    const sess = this.requireSession(params.sessionId);
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(params.selector)});
      if (!el) return { ok: false };
      el.value = ${JSON.stringify(params.value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`;
    const r = (await this.evalRaw(sess, expr)) as { ok: boolean } | undefined;
    if (!r?.ok) throw new WdpError(ErrorCodes.NotFound, `selector not found: ${params.selector}`);
    return { dispatched: true };
  }

  consoleLog(params: BrowserConsoleParams): BrowserConsoleResult {
    const sess = this.requireSession(params.sessionId);
    const since = params.since ? Date.parse(params.since) : -Infinity;
    const limit = params.limit ?? 100;
    const filtered = sess.console.filter((e) => Date.parse(e.timestamp) > since);
    return { entries: filtered.slice(-limit) };
  }

  private requireSession(sessionId: string): BrowserSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new WdpError(ErrorCodes.NotFound, `no such browser session: ${sessionId}`);
    return s;
  }

  private requireCdp(): CdpClient {
    if (!this.cdp) throw new WdpError(ErrorCodes.SubsystemNotReady, "browser CDP not connected");
    return this.cdp;
  }

  private async evalRaw(sess: BrowserSession, expression: string): Promise<unknown> {
    const cdp = this.requireCdp();
    const r = await cdp.call<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sess.cdpSessionId);
    if (r.exceptionDetails) {
      const message = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation failed";
      throw new WdpError(ErrorCodes.ToolError, message);
    }
    return r.result?.value;
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + this.opts.startupTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://${this.opts.host}:${this.port}/json/version`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await sleep(75);
    }
    throw new Error(`Lightpanda did not become ready within ${this.opts.startupTimeoutMs}ms`);
  }
}

/** Register the browser subsystem and its dispatcher methods. */
export function registerBrowserSubsystem(
  dispatcher: Dispatcher,
  browser: BrowserSubsystem,
): void {
  dispatcher.register<SessionCreateParams, SessionCreateResult>(
    "session.create", (p) => browser.createSession(p ?? {}),
  );
  dispatcher.register<unknown, SessionListResult>(
    "session.list", () => browser.listSessions(),
  );
  dispatcher.register<SessionCloseParams, SessionCloseResult>(
    "session.close", (p) => browser.closeSession(p),
  );
  dispatcher.register<BrowserNavigateParams, BrowserNavigateResult>(
    "browser.navigate", (p) => browser.navigate(p),
  );
  dispatcher.register<BrowserDomParams, BrowserDomResult>(
    "browser.dom", (p) => browser.dom(p),
  );
  dispatcher.register<BrowserEvalParams, BrowserEvalResult>(
    "browser.eval", (p) => browser.eval(p),
  );
  dispatcher.register<BrowserClickParams, BrowserClickResult>(
    "browser.click", (p) => browser.click(p),
  );
  dispatcher.register<BrowserFillParams, BrowserFillResult>(
    "browser.fill", (p) => browser.fill(p),
  );
  dispatcher.register<BrowserConsoleParams, BrowserConsoleResult>(
    "browser.console", (p) => browser.consoleLog(p),
  );
  dispatcher.register<InspectComponentTreeParams, InspectComponentTreeResult>(
    "inspect.componentTree", (p) => browser.componentTree(p),
  );
  dispatcher.register<InspectComponentByQueryParams, InspectComponentByQueryResult>(
    "inspect.componentByQuery", (p) => browser.componentByQuery(p),
  );
  dispatcher.register<InspectPropsParams, InspectPropsResult>(
    "inspect.props", (p) => browser.inspectProps(p),
  );
  dispatcher.register<InspectStateParams, InspectStateResult>(
    "inspect.state", (p) => browser.inspectState(p),
  );
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpProbe();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve();
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
