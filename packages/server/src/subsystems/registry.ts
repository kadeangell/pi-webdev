import { EventEmitter } from "node:events";

export type SubsystemState = "starting" | "ready" | "stopped" | "crashed";

export interface Subsystem {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Optional periodic health check; default is "always healthy". */
  heartbeat?(): Promise<boolean> | boolean;
}

interface Entry {
  subsystem: Subsystem;
  state: SubsystemState;
  reason?: string;
  /** Number of restart attempts since the last successful start. */
  restartCount: number;
}

export interface RegistryEvents {
  status: { name: string; state: SubsystemState; reason?: string };
}

/**
 * Tracks subsystem lifecycle. The foundation skeleton (Phase 1 Week 1) only
 * needs registration + start/stop hooks; real heartbeat + restart-with-backoff
 * is wired up but tuned conservatively until we have real subsystems to stress
 * it. See docs/05-subsystems.html for the supervision policy this implements.
 */
export class SubsystemRegistry extends EventEmitter {
  private entries = new Map<string, Entry>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs = 5000;

  register(subsystem: Subsystem): void {
    if (this.entries.has(subsystem.name)) {
      throw new Error(`Subsystem already registered: ${subsystem.name}`);
    }
    this.entries.set(subsystem.name, { subsystem, state: "stopped", restartCount: 0 });
  }

  list(): Array<{ name: string; state: SubsystemState; reason?: string }> {
    return [...this.entries.values()].map((e) => ({
      name: e.subsystem.name,
      state: e.state,
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
    }));
  }

  async startAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      await this.startOne(entry);
    }
    this.startHeartbeat();
  }

  async stopAll(): Promise<void> {
    this.stopHeartbeat();
    for (const entry of this.entries.values()) {
      if (entry.state === "stopped") continue;
      await this.stopOne(entry);
    }
  }

  private async startOne(entry: Entry): Promise<void> {
    this.transition(entry, "starting");
    try {
      await entry.subsystem.start();
      entry.restartCount = 0;
      this.transition(entry, "ready");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.transition(entry, "crashed", reason);
    }
  }

  private async stopOne(entry: Entry): Promise<void> {
    try {
      await entry.subsystem.stop();
    } catch {
      // best-effort
    }
    this.transition(entry, "stopped");
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.runHeartbeat();
    }, this.heartbeatIntervalMs);
    // The timer must not keep the event loop alive on its own.
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async runHeartbeat(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.state !== "ready" || !entry.subsystem.heartbeat) continue;
      try {
        const ok = await entry.subsystem.heartbeat();
        if (!ok) this.transition(entry, "crashed", "heartbeat reported unhealthy");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.transition(entry, "crashed", reason);
      }
    }
  }

  private transition(entry: Entry, state: SubsystemState, reason?: string): void {
    entry.state = state;
    entry.reason = reason;
    const payload: RegistryEvents["status"] = reason === undefined
      ? { name: entry.subsystem.name, state }
      : { name: entry.subsystem.name, state, reason };
    this.emit("status", payload);
  }
}
