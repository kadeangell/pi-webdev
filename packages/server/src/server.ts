import { WebSocketServer, type WebSocket } from "ws";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { Dispatcher } from "./dispatcher.js";
import { WdpConnection } from "./transport/connection.js";
import { SubsystemRegistry } from "./subsystems/registry.js";
import { detectCapabilities } from "./capabilities/detect.js";
import { registerHandshake } from "./domain/handshake.js";
import { EventMethods, type ServerCapabilities } from "@pi-webdev/shared-types";

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
}

/**
 * Foundation orchestration server. Owns the HTTP/WebSocket transport, the
 * dispatcher (method registry), the subsystem registry (lifecycle), and the
 * cached capability snapshot.
 *
 * Real subsystems plug in via `subsystems.register()` before `start()`; new
 * methods plug in via `dispatcher.register()` similarly.
 */
export class Server {
  readonly dispatcher = new Dispatcher();
  readonly subsystems = new SubsystemRegistry();
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private connections = new Map<string, WdpConnection>();
  private capabilities: ServerCapabilities | null = null;
  private readonly opts: Required<ServerOptions>;

  constructor(opts: ServerOptions = {}) {
    this.opts = {
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 48710,
      path: opts.path ?? "/wdp",
      projectRoot: opts.projectRoot ?? process.cwd(),
      serverName: opts.serverName ?? "@pi-webdev/server",
      serverVersion: opts.serverVersion ?? "0.1.0",
    };
    registerHandshake(this.dispatcher, {
      serverName: this.opts.serverName,
      serverVersion: this.opts.serverVersion,
      getCapabilities: () => this.getCapabilities(),
    });
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
    this.capabilities = await detectCapabilities(this.opts.projectRoot, this.dispatcher.registeredMethods());

    this.http = createHttpServer((_req, res) => {
      // WDP is WebSocket-only; bare HTTP requests get a hint.
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

  /** Push an event to every open connection. */
  broadcast<P>(method: string, params?: P): void {
    for (const conn of this.connections.values()) conn.emit(method, params);
  }

  private async getCapabilities(): Promise<ServerCapabilities> {
    if (this.capabilities === null) {
      this.capabilities = await detectCapabilities(this.opts.projectRoot, this.dispatcher.registeredMethods());
    } else {
      // Method list can grow after construction; keep it in sync.
      this.capabilities = { ...this.capabilities, methods: this.dispatcher.registeredMethods() };
    }
    return this.capabilities;
  }

  private acceptConnection(ws: WebSocket): void {
    const conn = new WdpConnection(ws, this.dispatcher, (c) => this.dropConnection(c));
    this.connections.set(conn.id, conn);
  }

  private dropConnection(conn: WdpConnection): void {
    this.connections.delete(conn.id);
  }
}

export async function createServer(opts: ServerOptions = {}): Promise<Server> {
  const s = new Server(opts);
  await s.start();
  return s;
}
