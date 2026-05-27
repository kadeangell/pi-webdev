import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ErrorCodes,
  WdpError,
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

export class FilesSubsystem implements Subsystem {
  readonly name = "files";
  private ready = false;

  constructor(private readonly projectRoot: string) {}

  async start(): Promise<void> {
    // Sanity: project root exists and is a directory.
    const st = await stat(this.projectRoot).catch(() => null);
    if (!st || !st.isDirectory()) {
      throw new Error(`projectRoot is not a directory: ${this.projectRoot}`);
    }
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
  }

  heartbeat(): boolean {
    return this.ready;
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
}
