import type {
  SessionCapabilitiesResult,
  SessionSubsystemsResult,
  ServerCapabilities,
} from "@pi-webdev/shared-types";
import type { Dispatcher } from "../dispatcher.js";
import type { SubsystemRegistry } from "../subsystems/registry.js";

export interface SessionOptions {
  getCapabilities: () => Promise<ServerCapabilities> | ServerCapabilities;
  registry: SubsystemRegistry;
}

export function registerSession(dispatcher: Dispatcher, opts: SessionOptions): void {
  dispatcher.register<unknown, SessionCapabilitiesResult>("session.capabilities", async () => ({
    capabilities: await opts.getCapabilities(),
  }));
  dispatcher.register<unknown, SessionSubsystemsResult>("session.subsystems", () => ({
    subsystems: opts.registry.list(),
  }));
}
