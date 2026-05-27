/**
 * ViteAdapter — week 3's first dev-server adapter.
 *
 * Vite exposes an HMR WebSocket alongside its dev server (default port 5173).
 * The adapter connects (manually via `build.connect` or auto-probed if the
 * port is reachable at startup), subscribes to HMR messages, and translates
 * them into WDP events (`hmr.update`, `build.completed`, …).
 *
 * The adapter stays optional — it advertises `state: "disconnected"` when no
 * Vite is reachable. The HMR ↔ browser bridge is wired in `server.ts`: when
 * `hmr.update` fires and a browser session is on a Vite-served URL, the
 * subsystem triggers a soft re-evaluation. For Lightpanda (no layout), a
 * full reload is the most reliable update path; we use that for v0.
 */
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ErrorCodes,
  WdpError,
  type BuildConnectParams,
  type BuildConnectResult,
  type BuildDisconnectResult,
  type BuildStatusResult,
} from "@pi-webdev/shared-types";
import type { Subsystem } from "./registry.js";
import type { Dispatcher } from "../dispatcher.js";

interface LastBuild {
  buildId: string;
  durationMs?: number;
  errors: number;
  warnings: number;
  finishedAt: string;
}

export interface ViteAdapterOptions {
  /** Auto-probe this URL on start(). When unreachable, the adapter stays disconnected. */
  probeUrl?: string;
  /** How long to wait for Vite to be reachable when auto-probing. */
  probeTimeoutMs?: number;
}

export class ViteAdapter implements Subsystem {
  readonly name = "vite";
  /** Emits `hmr` ({ modules, accepted }), `build` (LastBuild). */
  readonly events = new EventEmitter();
  private ws: WebSocket | null = null;
  private state: BuildStatusResult["state"] = "disconnected";
  private url: string | null = null;
  private reason: string | undefined;
  private last: LastBuild | null = null;
  private inflightBuildStart: number | null = null;

  constructor(private readonly opts: ViteAdapterOptions = {}) {}

  async start(): Promise<void> {
    if (!this.opts.probeUrl) return;
    // Best-effort auto-probe; doesn't fail start() when Vite isn't running.
    void this.tryConnect(this.opts.probeUrl, this.opts.probeTimeoutMs ?? 500).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.state = "disconnected";
    if (this.ws) {
      try { this.ws.close(); } catch { /* socket already gone */ }
      this.ws = null;
    }
  }

  heartbeat(): boolean {
    // The adapter is healthy whether or not Vite is connected — it's the
    // adapter's *availability* the registry cares about, not the dev server's.
    return true;
  }

  status(): BuildStatusResult {
    const result: BuildStatusResult = { state: this.state, adapter: "vite" };
    if (this.url) result.url = this.url;
    if (this.reason) result.reason = this.reason;
    if (this.last) result.last = this.last;
    return result;
  }

  async connect(params: BuildConnectParams): Promise<BuildConnectResult> {
    if (!params?.url) throw new WdpError(ErrorCodes.InvalidParams, "build.connect requires url");
    await this.tryConnect(params.url, 2000);
    return { state: this.state, url: this.url ?? params.url };
  }

  disconnect(): BuildDisconnectResult {
    if (this.ws) {
      try { this.ws.close(); } catch { /* already gone */ }
      this.ws = null;
    }
    this.state = "disconnected";
    this.url = null;
    delete this.reason;
    return { state: this.state };
  }

  private async tryConnect(httpUrl: string, timeoutMs: number): Promise<void> {
    this.state = "connecting";
    this.url = httpUrl;
    const wsUrl = toViteHmrWsUrl(httpUrl);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        // Vite serves /__vite_ping while alive; cheaper than the ws upgrade.
        const res = await fetch(new URL("/__vite_ping", httpUrl));
        if (res.ok) break;
      } catch {
        // not up yet
      }
      await sleep(50);
    }

    return new Promise<void>((resolve) => {
      const ws = new WebSocket(wsUrl, ["vite-hmr"]);
      const onOpen = () => {
        this.ws = ws;
        this.state = "connected";
        delete this.reason;
        ws.removeEventListener("error", onError);
        ws.addEventListener("message", (ev) => this.onMessage(ev.data));
        ws.addEventListener("close", () => this.onClose());
        resolve();
      };
      const onError = () => {
        this.state = "error";
        this.reason = "vite hmr ws unreachable";
        ws.removeEventListener("open", onOpen);
        resolve();
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
      // Short connection deadline; we don't block start() on a missing Vite.
      const t = setTimeout(() => onError(), Math.max(timeoutMs, 500));
      t.unref?.();
    });
  }

  private onClose(): void {
    if (this.state === "connected") {
      this.state = "disconnected";
      this.reason = "vite hmr ws closed";
    }
    this.ws = null;
  }

  private onMessage(raw: unknown): void {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    // Vite HMR message kinds — see vite/dist/node/client/types/hmrPayload.d.ts.
    switch (msg.type) {
      case "update": {
        const modules: string[] = (msg.updates ?? []).map((u: { path?: string; acceptedPath?: string }) =>
          u.acceptedPath ?? u.path ?? "",
        ).filter(Boolean);
        this.events.emit("hmr", { modules, accepted: true });
        break;
      }
      case "full-reload": {
        this.events.emit("hmr", { modules: msg.path ? [msg.path] : [], accepted: false });
        break;
      }
      case "error": {
        const finishedAt = new Date().toISOString();
        this.last = {
          buildId: `vite-${Date.now()}`,
          errors: 1,
          warnings: 0,
          finishedAt,
        };
        this.events.emit("build", { ...this.last, error: msg.err });
        break;
      }
      case "connected": {
        // server announces it's ready — surface as a no-op "completed".
        const finishedAt = new Date().toISOString();
        this.last = { buildId: `vite-${Date.now()}`, errors: 0, warnings: 0, finishedAt };
        this.events.emit("build", this.last);
        break;
      }
      default: {
        // Unknown HMR message kind; ignore for forward-compat.
      }
    }
  }
}

export function registerViteAdapter(dispatcher: Dispatcher, vite: ViteAdapter): void {
  dispatcher.register<unknown, BuildStatusResult>("build.status", () => vite.status());
  dispatcher.register<BuildConnectParams, BuildConnectResult>(
    "build.connect", (p) => vite.connect(p),
  );
  dispatcher.register<unknown, BuildDisconnectResult>("build.disconnect", () => vite.disconnect());
}

function toViteHmrWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/`;
}
