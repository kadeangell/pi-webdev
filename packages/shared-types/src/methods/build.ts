/**
 * `build.*` and `hmr.*` shapes. The build adapter (Vite for v0) wraps a
 * specific dev-server tool; the protocol stays generic.
 */

export interface BuildStatusResult {
  /** "connected" when the adapter is talking to a real dev server. */
  state: "disconnected" | "connecting" | "connected" | "error";
  adapter?: "vite" | "next" | "webpack" | "unknown";
  url?: string;
  /** Most recent build outcome, if known. */
  last?: {
    buildId: string;
    durationMs?: number;
    errors: number;
    warnings: number;
    finishedAt: string;
  };
  reason?: string;
}

export interface BuildConnectParams {
  /** Dev-server URL — usually http://127.0.0.1:5173/ for Vite. */
  url: string;
}
export interface BuildConnectResult {
  state: BuildStatusResult["state"];
  url: string;
}

export interface BuildDisconnectResult {
  state: BuildStatusResult["state"];
}

export interface HmrUpdateEvent {
  /** ISO timestamp at which the update fired. */
  timestamp: string;
  /** Module paths that updated. */
  modules: string[];
  /** True if the runtime is going to accept this update without a full reload. */
  accepted: boolean;
}

export const BuildEventMethods = {
  HmrUpdate: "hmr.update",
  HmrReload: "hmr.reload",
  BuildStarted: "build.started",
  BuildCompleted: "build.completed",
  BuildFailed: "build.failed",
} as const;
