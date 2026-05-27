/**
 * Server-emitted event payloads. Doc 03-protocol §3.3 lists the v1
 * surface; only the ones the foundation actually emits are typed for
 * real here — the others are placeholders until their subsystems land.
 */

export interface ServerReadyEvent {
  serverVersion: string;
  projectRoot?: string;
}

export interface SubsystemStatusEvent {
  name: string;
  state: "starting" | "ready" | "stopped" | "crashed";
  reason?: string;
}

export const EventMethods = {
  ServerReady: "$/serverReady",
  SubsystemStatus: "$/subsystem.status",
} as const;
