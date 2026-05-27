import type { WdpClient } from "../client/index.js";
import type { PingResult } from "@pi-webdev/shared-types";

export interface ToolDefinition<P, R> {
  name: string;
  description: string;
  /** JSON Schema sketch; Pi's `registerTool` validates against this. */
  schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  invoke: (args: P) => Promise<R>;
}

export interface PingArgs {
  echo?: string;
}

/** Build a Pi tool definition for round-trip liveness checks. */
export function pingTool(wdp: WdpClient): ToolDefinition<PingArgs, PingResult> {
  return {
    name: "wdp.ping",
    description: "Round-trip a ping to the orchestration server. Returns server time and optional echo. Used to verify the dev environment daemon is reachable.",
    schema: {
      type: "object",
      properties: {
        echo: { type: "string", description: "Optional string echoed back by the server." },
      },
      additionalProperties: false,
    },
    invoke: (args) => wdp.call<PingResult>("$/ping", args ?? {}),
  };
}
