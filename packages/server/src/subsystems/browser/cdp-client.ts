/**
 * Minimal CDP-over-WebSocket client. Not a general-purpose chrome-remote-interface
 * replacement — it implements just enough of CDP for the WDP browser surface:
 *   - request/response by id
 *   - per-target sessions via `Target.attachToTarget({flatten: true})`
 *   - event subscription (with and without sessionId scoping)
 *
 * Uses Node 22's built-in WebSocket. Lightpanda speaks CDP-over-ws on
 * `ws://host:port/` (no per-target ws path; flatten mode multiplexes via
 * sessionId on each message).
 */

export type CdpEventListener = (params: any, sessionId?: string) => void;

interface Pending {
  resolve: (v: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CdpClientOptions {
  url: string;
  requestTimeoutMs?: number;
}

export class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<CdpEventListener>>();
  private requestTimeoutMs: number;
  private closed = false;

  constructor(private readonly opts: CdpClientOptions) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10000;
  }

  static async connect(url: string, opts: { requestTimeoutMs?: number } = {}): Promise<CdpClient> {
    const client = new CdpClient({ url, ...opts });
    await client.open();
    return client;
  }

  isOpen(): boolean {
    return !!this.ws && !this.closed;
  }

  /** Invoke a CDP method. Pass sessionId for target-scoped methods. */
  async call<R = any>(method: string, params: any = {}, sessionId?: string): Promise<R> {
    if (!this.ws || this.closed) throw new Error("CdpClient: socket not open");
    const id = this.nextId++;
    const body: { id: number; method: string; params: any; sessionId?: string } = { id, method, params };
    if (sessionId) body.sessionId = sessionId;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(body));
    });
  }

  on(method: string, listener: CdpEventListener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("CdpClient closed"));
    }
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      await new Promise<void>((resolve) => {
        ws.addEventListener("close", () => resolve(), { once: true });
        try {
          ws.close(1000);
        } catch {
          resolve();
        }
      });
    }
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      const onOpen = () => {
        ws.removeEventListener("error", onError);
        this.ws = ws;
        ws.addEventListener("message", (ev) => this.onMessage(ev.data));
        ws.addEventListener("close", () => this.onSocketClose());
        resolve();
      };
      const onError = () => {
        ws.removeEventListener("open", onOpen);
        reject(new Error(`CdpClient: failed to connect to ${this.opts.url}`));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });
  }

  private onMessage(raw: unknown): void {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") {
      const set = this.listeners.get(msg.method);
      if (!set) return;
      for (const l of set) {
        try { l(msg.params, msg.sessionId); } catch { /* isolated */ }
      }
    }
  }

  private onSocketClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP socket closed"));
    }
    this.pending.clear();
    this.ws = null;
  }
}
