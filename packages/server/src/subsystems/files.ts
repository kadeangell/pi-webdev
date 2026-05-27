import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import * as esbuild from "esbuild";
import {
  ErrorCodes,
  WdpError,
  type FilesChangeEntry,
  type FilesChangedSinceParams,
  type FilesChangedSinceResult,
  type FilesDepGraphParams,
  type FilesDepGraphResult,
  type FilesListParams,
  type FilesListResult,
  type FilesReadParams,
  type FilesReadResult,
  type FilesWriteParams,
  type FilesWriteResult,
} from "@pi-webdev/shared-types";
import type { Subsystem } from "./registry.js";
import type { Dispatcher } from "../dispatcher.js";

/** Default skip list for `files.list` walks — large and unhelpful directories. */
const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".pnpm-store",
  ".cache",
]);

const MAX_READ_BYTES = 1 * 1024 * 1024; // 1 MiB cap per read
const DEFAULT_LIST_LIMIT = 1000;
const MAX_LIST_LIMIT = 5000;

const RING_BUFFER_LIMIT = 1000;
const COALESCE_WINDOW_MS = 100;

export class FilesSubsystem implements Subsystem {
  readonly name = "files";
  /** Emits `changed` (FilesChangeEntry[]) when coalesced events flush. */
  readonly events = new EventEmitter();
  private ready = false;
  private watcher: FSWatcher | null = null;
  private ring: FilesChangeEntry[] = [];
  private pendingBuffer: FilesChangeEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private sequence = 0;

  constructor(private readonly projectRoot: string) {}

  async start(): Promise<void> {
    const st = await stat(this.projectRoot).catch(() => null);
    if (!st || !st.isDirectory()) {
      throw new Error(`projectRoot is not a directory: ${this.projectRoot}`);
    }
    // Chokidar watch — the ignore list is intentionally narrower than
    // `files.list`'s: hidden dotfiles can still be interesting to the LLM
    // (.env edits, .gitignore changes), so only large/unhelpful trees are
    // skipped here.
    this.watcher = chokidar.watch(this.projectRoot, {
      ignoreInitial: true,
      ignored: (p: string) => {
        const rel = path.relative(this.projectRoot, p);
        if (!rel || rel === "") return false;
        const first = rel.split(path.sep)[0]!;
        return DEFAULT_IGNORE.has(first);
      },
      // Polling is the most reliable across container/overlay filesystems.
      usePolling: process.env.PI_WEBDEV_POLL !== "0",
      interval: 50,
    });
    const handle = (kind: FilesChangeEntry["kind"]) => (raw: string) => {
      const rel = path.relative(this.projectRoot, raw);
      // chokidar may surface paths outside root on macOS symlink follow; skip those.
      if (rel.startsWith("..") || path.isAbsolute(rel)) return;
      this.bufferChange({ path: rel, kind, timestamp: new Date().toISOString() });
    };
    this.watcher
      .on("add", handle("add"))
      .on("change", handle("change"))
      .on("unlink", handle("unlink"))
      .on("addDir", handle("addDir"))
      .on("unlinkDir", handle("unlinkDir"));
    // Wait for the initial scan to complete so subsequent events are real changes.
    await new Promise<void>((resolve) => this.watcher!.once("ready", resolve));
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingBuffer = [];
    if (this.watcher) {
      await this.watcher.close().catch(() => undefined);
      this.watcher = null;
    }
  }

  heartbeat(): boolean {
    return this.ready;
  }

  private bufferChange(entry: FilesChangeEntry): void {
    this.pendingBuffer.push(entry);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushChanges(), COALESCE_WINDOW_MS);
    this.flushTimer.unref?.();
  }

  private flushChanges(): void {
    this.flushTimer = null;
    if (this.pendingBuffer.length === 0) return;
    // Coalesce — collapse repeats of the same path+kind in the window.
    const seen = new Map<string, FilesChangeEntry>();
    for (const e of this.pendingBuffer) {
      seen.set(`${e.kind}:${e.path}`, e);
    }
    this.pendingBuffer = [];
    const coalesced = [...seen.values()];
    for (const e of coalesced) {
      this.ring.push(e);
      this.sequence += 1;
    }
    if (this.ring.length > RING_BUFFER_LIMIT) {
      this.ring.splice(0, this.ring.length - RING_BUFFER_LIMIT);
    }
    this.events.emit("changed", coalesced);
  }

  changedSince(params: FilesChangedSinceParams): FilesChangedSinceResult {
    if (!this.ready) throw new WdpError(ErrorCodes.SubsystemNotReady, "files subsystem not ready");
    const since = Date.parse(params.since);
    if (Number.isNaN(since)) throw new WdpError(ErrorCodes.InvalidParams, "since must be an ISO timestamp");
    const limit = Math.min(params.limit ?? 200, 1000);
    const prefix = params.pathPrefix ?? "";
    const matches = this.ring.filter(
      (e) => Date.parse(e.timestamp) > since && (prefix === "" || e.path.startsWith(prefix)),
    );
    const truncated = matches.length > limit;
    const slice = matches.slice(-limit);
    const cursor = (slice[slice.length - 1]?.timestamp) ?? params.since;
    return { changes: slice, cursor, truncated };
  }

  async depGraph(params: FilesDepGraphParams): Promise<FilesDepGraphResult> {
    if (!this.ready) throw new WdpError(ErrorCodes.SubsystemNotReady, "files subsystem not ready");
    if (!params?.entry) throw new WdpError(ErrorCodes.InvalidParams, "files.depGraph requires entry: string");
    const absEntry = this.resolveInsideRoot(params.entry);
    let metafile: esbuild.Metafile;
    const warnings: string[] = [];
    try {
      const result = await esbuild.build({
        entryPoints: [absEntry],
        absWorkingDir: this.projectRoot,
        bundle: true,
        write: false,
        metafile: true,
        platform: "browser",
        format: "esm",
        target: "es2022",
        logLevel: "silent",
        jsx: "automatic",
        loader: { ".tsx": "tsx", ".ts": "ts", ".jsx": "jsx", ".js": "js", ".css": "empty", ".svg": "empty" },
        plugins: [
          {
            // Skip resolving anything that isn't a relative or absolute path —
            // node_modules and bare specifiers become external edges.
            name: "wdp-mark-external",
            setup(build) {
              build.onResolve({ filter: /^[^./]/ }, (args) => ({
                path: args.path,
                external: true,
              }));
            },
          },
        ],
      });
      metafile = result.metafile!;
    } catch (err) {
      throw new WdpError(
        ErrorCodes.ToolError,
        `dep graph failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const nodes = Object.entries(metafile.inputs).map(([id, info]) => ({ id, bytes: info.bytes }));
    const edges: { from: string; to: string; kind: "import" | "dynamic" }[] = [];
    for (const [id, info] of Object.entries(metafile.inputs)) {
      for (const imp of info.imports) {
        edges.push({ from: id, to: imp.path, kind: imp.kind === "dynamic-import" ? "dynamic" : "import" });
      }
    }
    return {
      entry: path.relative(this.projectRoot, absEntry),
      graph: { nodes, edges },
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /** Resolve a project-relative or absolute path, refusing anything outside root. */
  private resolveInsideRoot(input: string): string {
    const resolved = path.resolve(this.projectRoot, input);
    const rel = path.relative(this.projectRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new WdpError(
        ErrorCodes.InvalidArgument,
        `Path escapes project root: ${input}`,
      );
    }
    return resolved;
  }

  async read(params: FilesReadParams): Promise<FilesReadResult> {
    if (!this.ready) throw new WdpError(ErrorCodes.SubsystemNotReady, "files subsystem not ready");
    if (!params?.path || typeof params.path !== "string") {
      throw new WdpError(ErrorCodes.InvalidParams, "files.read requires path: string");
    }
    const abs = this.resolveInsideRoot(params.path);
    const st = await stat(abs).catch(() => null);
    if (!st) throw new WdpError(ErrorCodes.NotFound, `file not found: ${params.path}`);
    if (!st.isFile()) throw new WdpError(ErrorCodes.InvalidArgument, `not a regular file: ${params.path}`);

    const fileSize = st.size;
    let start = 0;
    let end = Math.min(fileSize, MAX_READ_BYTES);
    let truncated = fileSize > MAX_READ_BYTES;
    if (params.range) {
      const [s, e] = params.range;
      if (s < 0 || e < s) throw new WdpError(ErrorCodes.InvalidArgument, "invalid range");
      start = Math.min(s, fileSize);
      const requestedEnd = Math.min(e, fileSize);
      if (requestedEnd - start > MAX_READ_BYTES) {
        end = start + MAX_READ_BYTES;
        truncated = true;
      } else {
        end = requestedEnd;
        truncated = false;
      }
    }

    const buf = await readFile(abs);
    const slice = buf.subarray(start, end);
    const encoding = params.encoding ?? "utf8";
    const content = encoding === "base64" ? slice.toString("base64") : slice.toString("utf8");
    return {
      path: path.relative(this.projectRoot, abs),
      content,
      encoding,
      byteLength: slice.length,
      truncated,
    };
  }

  async write(params: FilesWriteParams): Promise<FilesWriteResult> {
    if (!this.ready) throw new WdpError(ErrorCodes.SubsystemNotReady, "files subsystem not ready");
    if (!params?.path || typeof params.path !== "string") {
      throw new WdpError(ErrorCodes.InvalidParams, "files.write requires path: string");
    }
    if (typeof params.content !== "string") {
      throw new WdpError(ErrorCodes.InvalidParams, "files.write requires content: string");
    }
    const abs = this.resolveInsideRoot(params.path);
    const existed = (await stat(abs).catch(() => null)) !== null;
    if (params.createDirs) {
      await mkdir(path.dirname(abs), { recursive: true });
    }
    const encoding = params.encoding ?? "utf8";
    const buf = encoding === "base64" ? Buffer.from(params.content, "base64") : Buffer.from(params.content, "utf8");
    await writeFile(abs, buf);
    return {
      path: path.relative(this.projectRoot, abs),
      bytesWritten: buf.length,
      created: !existed,
    };
  }

  async list(params: FilesListParams = {}): Promise<FilesListResult> {
    if (!this.ready) throw new WdpError(ErrorCodes.SubsystemNotReady, "files subsystem not ready");
    const baseDir = this.resolveInsideRoot(params.dir ?? ".");
    const limit = Math.min(params.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const matcher = params.glob ? globToRegex(params.glob) : null;

    const out: string[] = [];
    let truncated = false;
    const stack: string[] = [baseDir];
    while (stack.length > 0) {
      if (out.length >= limit) {
        truncated = true;
        break;
      }
      const dir = stack.pop()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (DEFAULT_IGNORE.has(entry.name) || entry.name.startsWith(".")) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(abs);
        } else if (entry.isFile()) {
          const rel = path.relative(this.projectRoot, abs);
          if (!matcher || matcher.test(rel)) {
            out.push(rel);
            if (out.length >= limit) {
              truncated = true;
              break;
            }
          }
        }
      }
    }
    out.sort();
    return { paths: out, truncated };
  }
}

/**
 * Tiny glob → RegExp. Supports `**`, `*`, `?`, `[...]`. Pattern is anchored
 * to the project-relative path. Good enough for the foundation; chokidar
 * arrives with proper globbing in week 3.
 */
function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // consume the slash too
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const close = glob.indexOf("]", i);
      if (close === -1) {
        re += "\\[";
      } else {
        re += glob.slice(i, close + 1);
        i = close;
      }
    } else if (".+^$(){}|\\".includes(c!)) {
      re += "\\" + c;
    } else if (c === "/") {
      re += "/";
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** Register the files subsystem and its dispatcher methods. */
export function registerFilesSubsystem(
  dispatcher: Dispatcher,
  files: FilesSubsystem,
): void {
  dispatcher.register<FilesReadParams, FilesReadResult>("files.read", (p) => files.read(p));
  dispatcher.register<FilesListParams, FilesListResult>("files.list", (p) => files.list(p ?? {}));
  dispatcher.register<FilesWriteParams, FilesWriteResult>("files.write", (p) => files.write(p));
  dispatcher.register<FilesChangedSinceParams, FilesChangedSinceResult>(
    "files.changedSince", (p) => files.changedSince(p),
  );
  dispatcher.register<FilesDepGraphParams, FilesDepGraphResult>(
    "files.depGraph", (p) => files.depGraph(p),
  );
}
