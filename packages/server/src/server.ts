import { WebSocketServer, type WebSocket } from "ws";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Dispatcher } from "./dispatcher.js";
import { WdpConnection } from "./transport/connection.js";
import { SubsystemRegistry } from "./subsystems/registry.js";
import { detectCapabilities } from "./capabilities/detect.js";
import { registerHandshake } from "./domain/handshake.js";
import { registerSession } from "./domain/session.js";
import { FilesSubsystem, registerFilesSubsystem } from "./subsystems/files.js";
import { BrowserSubsystem, registerBrowserSubsystem } from "./subsystems/browser/index.js";
import { ViteAdapter, registerViteAdapter } from "./subsystems/vite.js";
import {
  BuildEventMethods,
  EventMethods,
  type FilesChangeEntry,
  type ServerCapabilities,
} from "@pi-webdev/shared-types";

export interface ServerOptions {
  /** Bind host. Defaults to 127.0.0.1 — WDP is local-only by design. */
  host?: string;
  /** TCP port. 0 picks an ephemeral port (useful for tests). */
  port?: number;
  /** WebSocket subpath. Defaults to /wdp. */
  path?: string;
  /** Project root the server believes it's operating on. */
  projectRoot?: string;
  serverName?: string;
  serverVersion?: string;
  /** Browser subsystem config. Pass `false` to disable entirely. */
  browser?: false | {
    /** Path to the lightpanda binary. Auto-resolved from PATH if omitted. */
    binary?: string;
    /** Override port (otherwise an OS-assigned ephemeral port is used). */
    port?: number;
  };
  /** Vite adapter config. Pass `false` to disable. By default the adapter is
   *  registered and stays disconnected until `build.connect` is called. */
  vite?: false | {
    /** Auto-probe this URL on start(). Defaults to none. */
    probeUrl?: string;
  };
}

/**
 * Orchestration server. Owns the HTTP/WebSocket transport, the dispatcher
 * (method registry), the subsystem registry (lifecycle), and the cached
 * capability snapshot.
 *
 * Subsystems plug in via `subsystems.register()` before `start()`; methods
 * plug in via `dispatcher.register()` similarly.
 */
export class Server {
  readonly dispatcher = new Dispatcher();
  readonly subsystems = new SubsystemRegistry();
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private connections = new Map<string, WdpConnection>();
  private capabilities: ServerCapabilities | null = null;
  private browserVersion: string | null = null;
  private browserSubsystem: BrowserSubsystem | null = null;
  private viteAdapter: ViteAdapter | null = null;
  private readonly opts: Required<Omit<ServerOptions, "browser" | "vite">> & {
    browser: ServerOptions["browser"];
    vite: ServerOptions["vite"];
  };

  constructor(opts: ServerOptions = {}) {
    this.opts = {
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 48710,
      path: opts.path ?? "/wdp",
      projectRoot: opts.projectRoot ?? process.cwd(),
      serverName: opts.serverName ?? "@pi-webdev/server",
      serverVersion: opts.serverVersion ?? "0.1.0",
      browser: opts.browser,
      vite: opts.vite,
    };
    registerHandshake(this.dispatcher, {
      serverName: this.opts.serverName,
      serverVersion: this.opts.serverVersion,
      getCapabilities: () => this.getCapabilities(),
    });
    registerSession(this.dispatcher, {
      getCapabilities: () => this.getCapabilities(),
      registry: this.subsystems,
    });
    const files = new FilesSubsystem(this.opts.projectRoot);
    this.subsystems.register(files);
    registerFilesSubsystem(this.dispatcher, files);
    files.events.on("changed", (entries: FilesChangeEntry[]) => {
      this.broadcast("files.changed", { entries });
    });

    if (opts.vite !== false) {
      const viteOpts: { probeUrl?: string } = {};
      const cfg = opts.vite;
      if (cfg && typeof cfg === "object" && cfg.probeUrl) viteOpts.probeUrl = cfg.probeUrl;
      const vite = new ViteAdapter(viteOpts);
      this.viteAdapter = vite;
      this.subsystems.register(vite);
      registerViteAdapter(this.dispatcher, vite);
      vite.events.on("hmr", (params: { modules: string[]; accepted: boolean }) => {
        this.broadcast(BuildEventMethods.HmrUpdate, {
          timestamp: new Date().toISOString(),
          ...params,
        });
        // Bridge to browser sessions: full reload when the update isn't accepted.
        if (!params.accepted && this.browserSubsystem) {
          for (const s of this.browserSubsystem.listSessions().sessions) {
            void this.browserSubsystem.eval({
              sessionId: s.sessionId,
              expression: "location.reload(); null",
            }).catch(() => undefined);
          }
        }
      });
      vite.events.on("build", (last: { buildId: string; errors: number; warnings: number; finishedAt: string }) => {
        this.broadcast(last.errors > 0 ? BuildEventMethods.BuildFailed : BuildEventMethods.BuildCompleted, last);
      });
    }

    const browserBinary = this.resolveBrowserBinary();
    if (browserBinary) {
      this.browserVersion = readBinaryVersion(browserBinary);
      const browserOpts: { binary: string; port?: number } = { binary: browserBinary };
      const cfg = this.opts.browser;
      if (cfg && typeof cfg === "object" && cfg.port !== undefined) {
        browserOpts.port = cfg.port;
      }
      this.browserSubsystem = new BrowserSubsystem(browserOpts);
      this.subsystems.register(this.browserSubsystem);
      registerBrowserSubsystem(this.dispatcher, this.browserSubsystem);
    }

    this.subsystems.on("status", (status) => {
      this.broadcast(EventMethods.SubsystemStatus, status);
    });
  }

  /** Resolved port after start(). Useful when port: 0 was passed. */
  get port(): number {
    const addr = this.http?.address();
    if (!addr || typeof addr === "string") return -1;
    return addr.port;
  }

  get url(): string {
    return `ws://${this.opts.host}:${this.port}${this.opts.path}`;
  }

  async start(): Promise<void> {
    await this.subsystems.startAll();
    this.capabilities = await this.composeCapabilities();

    this.http = createHttpServer((_req, res) => {
      res.writeHead(426, { "content-type": "application/json", "upgrade": "websocket" });
      res.end(JSON.stringify({ error: "WDP requires WebSocket upgrade", path: this.opts.path }));
    });

    this.wss = new WebSocketServer({ server: this.http, path: this.opts.path });
    this.wss.on("connection", (ws: WebSocket) => this.acceptConnection(ws));

    await new Promise<void>((resolve, reject) => {
      this.http!.once("error", reject);
      this.http!.listen(this.opts.port, this.opts.host, () => {
        this.http!.off("error", reject);
        resolve();
      });
    });

    this.broadcast(EventMethods.ServerReady, {
      serverVersion: this.opts.serverVersion,
      projectRoot: this.opts.projectRoot,
    });
  }

  async stop(): Promise<void> {
    for (const conn of this.connections.values()) conn.close("server shutting down");
    this.connections.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }
    if (this.http) {
      await new Promise<void>((resolve) => this.http!.close(() => resolve()));
      this.http = null;
    }
    await this.subsystems.stopAll();
  }

  broadcast<P>(method: string, params?: P): void {
    for (const conn of this.connections.values()) conn.emit(method, params);
  }

  private async getCapabilities(): Promise<ServerCapabilities> {
    if (this.capabilities === null) {
      this.capabilities = await this.composeCapabilities();
    } else {
      this.capabilities = { ...this.capabilities, methods: this.dispatcher.registeredMethods() };
    }
    return this.capabilities;
  }

  private async composeCapabilities(): Promise<ServerCapabilities> {
    const caps = await detectCapabilities(this.opts.projectRoot, this.dispatcher.registeredMethods());
    if (this.browserSubsystem) {
      const browserEntry = this.subsystems.list().find((s) => s.name === "browser");
      const ready = browserEntry?.state === "ready";
      caps.browser = {
        engine: "lightpanda",
        ...(this.browserVersion ? { version: this.browserVersion } : {}),
        features: ["dom", "js", "fetch", "cookies"],
        limitations: ready ? ["no-layout", "no-webgl", "no-service-workers"] : ["subsystem-not-ready"],
      };
    }
    return caps;
  }

  private acceptConnection(ws: WebSocket): void {
    const conn = new WdpConnection(ws, this.dispatcher, (c) => this.dropConnection(c));
    this.connections.set(conn.id, conn);
  }

  private dropConnection(conn: WdpConnection): void {
    this.connections.delete(conn.id);
  }

  private resolveBrowserBinary(): string | null {
    const cfg = this.opts.browser;
    if (cfg === false) return null;
    const candidate = cfg?.binary ?? process.env.LIGHTPANDA_BIN ?? "lightpanda";
    if (path.isAbsolute(candidate)) {
      return existsSync(candidate) ? candidate : null;
    }
    return resolveInPath(candidate);
  }
}

export async function createServer(opts: ServerOptions = {}): Promise<Server> {
  const s = new Server(opts);
  await s.start();
  return s;
}

function resolveInPath(name: string): string | null {
  const sep = process.platform === "win32" ? ";" : ":";
  const exts = process.platform === "win32" ? (process.env.PATHEXT?.split(";") ?? [".EXE"]) : [""];
  const dirs = (process.env.PATH ?? "").split(sep);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function readBinaryVersion(binary: string): string | null {
  try {
    const out = execFileSync(binary, ["version"], { encoding: "utf8", timeout: 2000 });
    return out.trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}
