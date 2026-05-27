import {
  ErrorCodes,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  WdpError,
  isErrorResponse,
  isEvent,
  isResponse,
  type InitializeParams,
  type InitializeResult,
  type WdpCommand,
  type WdpMessage,
  type WdpResponse,
} from "@pi-webdev/shared-types";

export type EventListener = (params: unknown) => void;

export interface WdpClientOptions {
  url: string;
  client: string;
  clientVersion?: string;
  /** Per-command default timeout. */
  requestTimeoutMs?: number;
  /** Custom WebSocket implementation (lets tests inject mocks). */
  webSocketImpl?: typeof WebSocket;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: WdpError) => void;
  timer: NodeJS.Timeout;
}

/**
 * Thin WDP client. Mirrors `WdpClient` from doc 02-pi-integration §2.3 —
 * the extension wires this into Pi's `registerTool` hook, the smoke test
 * uses it directly.
 */
export class WdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<EventListener>>();
  private initialized = false;
  private capabilities: InitializeResult | null = null;
  private readonly opts: Required<Omit<WdpClientOptions, "clientVersion" | "webSocketImpl">> & {
    clientVersion?: string;
    webSocketImpl: typeof WebSocket;
  };

  constructor(opts: WdpClientOptions) {
    const Ws = opts.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Ws) {
      throw new Error("WdpClient: no WebSocket implementation available; pass webSocketImpl");
    }
    this.opts = {
      url: opts.url,
      client: opts.client,
      requestTimeoutMs: opts.requestTimeoutMs ?? 5000,
      ...(opts.clientVersion !== undefined ? { clientVersion: opts.clientVersion } : {}),
      webSocketImpl: Ws,
    };
  }

  /** Connect, handshake, return the server's advertised capabilities. */
  static async connect(opts: WdpClientOptions): Promise<WdpClient> {
    const client = new WdpClient(opts);
    await client.openSocket();
    await client.handshake();
    return client;
  }

  capabilitiesSnapshot(): InitializeResult | null {
    return this.capabilities;
  }

  async call<R = unknown, P = unknown>(method: string, params?: P): Promise<R> {
    if (!this.ws) throw new WdpError(ErrorCodes.SubsystemUnavailable, "WdpClient: socket not open");
    const id = this.nextId++;
    const cmd: WdpCommand<P> = params === undefined ? { id, method } : { id, method, params };

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new WdpError(ErrorCodes.Timeout, `WDP call timed out: ${method}`));
      }, this.opts.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as Pending["resolve"],
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify(cmd));
    });
  }

  on(method: string, listener: EventListener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  async close(): Promise<void> {
    if (!this.ws) return;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new WdpError(ErrorCodes.SubsystemUnavailable, "WdpClient closed"));
    }
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      ws.addEventListener("close", done, { once: true });
      try {
        ws.close(1000, "client closing");
      } catch {
        done();
      }
    });
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const Ws = this.opts.webSocketImpl;
      const socket = new Ws(this.opts.url);
      socket.addEventListener("open", () => {
        this.ws = socket;
        socket.addEventListener("message", (ev: MessageEvent) => this.onMessage(ev.data));
        socket.addEventListener("close", () => this.onSocketClose());
        socket.addEventListener("error", () => {
          // Surface as close — same effect.
        });
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => reject(new Error(`WdpClient: failed to connect to ${this.opts.url}`)), { once: true });
    });
  }

  private async handshake(): Promise<void> {
    const params: InitializeParams = {
      client: this.opts.client,
      supportedVersions: [...SUPPORTED_VERSIONS, PROTOCOL_VERSION],
      ...(this.opts.clientVersion !== undefined ? { clientVersion: this.opts.clientVersion } : {}),
    };
    this.capabilities = await this.call<InitializeResult>("$/initialize", params);
    this.initialized = true;
  }

  private onSocketClose(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new WdpError(ErrorCodes.SubsystemUnavailable, "WDP connection closed"));
    }
    this.pending.clear();
    this.ws = null;
    this.initialized = false;
  }

  private onMessage(raw: unknown): void {
    let parsed: WdpMessage;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : String(raw)) as WdpMessage;
    } catch {
      return;
    }
    if (isResponse(parsed)) this.deliverResponse(parsed);
    else if (isEvent(parsed)) this.deliverEvent(parsed.method, parsed.params);
  }

  private deliverResponse(msg: WdpResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (isErrorResponse(msg)) {
      p.reject(new WdpError(msg.error.code, msg.error.message, msg.error.data));
    } else {
      p.resolve(msg.result);
    }
  }

  private deliverEvent(method: string, params: unknown): void {
    const set = this.listeners.get(method);
    if (!set) return;
    for (const l of set) {
      try {
        l(params);
      } catch {
        // listener errors are isolated
      }
    }
  }
}
