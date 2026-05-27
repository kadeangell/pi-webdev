/**
 * `session.*` method shapes. The foundation only serves `capabilities`
 * and `subsystems` — `create`/`close` arrive once a real session model
 * (browser context, etc.) needs to be partitioned.
 */
import type { ServerCapabilities } from "../capabilities.js";

export interface SessionCapabilitiesResult {
  capabilities: ServerCapabilities;
}

export interface SessionSubsystemsResult {
  subsystems: Array<{
    name: string;
    state: "starting" | "ready" | "stopped" | "crashed";
    reason?: string;
  }>;
}
