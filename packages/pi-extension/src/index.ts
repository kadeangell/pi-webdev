import { WdpClient } from "./client/index.js";
import { pingTool, type ToolDefinition } from "./tools/ping.js";

export { WdpClient } from "./client/index.js";
export { pingTool, type ToolDefinition, type PingArgs } from "./tools/ping.js";

/**
 * Shape of the Pi extension. Wired to Pi's `defineExtension` once the
 * actual Pi types are pulled in; for now we keep the signature self-contained
 * so this package builds without a Pi dependency.
 *
 * Pi's hooks (from docs/02-pi-integration.html §2.2):
 *   registerTool(name, schema, handler)
 *   registerSkill(folder)
 *   onTurnStart(handler)
 *
 * The real `defineExtension` import will replace this stub once we have a Pi
 * version pinned. See docs/PROGRESS.html "Pi extension API binding".
 */
export interface PiExtensionHost {
  registerTool: <P, R>(
    name: string,
    schema: ToolDefinition<P, R>["schema"],
    handler: (args: P) => Promise<R>,
  ) => void;
  onTurnStart?: (
    handler: (ctx: { lastTurnTimestamp?: number; appendSystemMessage: (text: string) => void }) => Promise<void> | void,
  ) => void;
}

export interface BuildExtensionOptions {
  wdpUrl?: string;
  clientName?: string;
  clientVersion?: string;
}

/**
 * Build a Pi-compatible extension setup function. Returns a function that
 * Pi calls during `defineExtension({ setup })` — for now we mirror the
 * sketched API in docs/02-pi-integration.html §2.3 without taking a hard
 * dependency on Pi's package.
 */
export function buildExtension(opts: BuildExtensionOptions = {}) {
  return async function setup(host: PiExtensionHost): Promise<{ wdp: WdpClient; close: () => Promise<void> }> {
    const wdp = await WdpClient.connect({
      url: opts.wdpUrl ?? process.env.WDP_URL ?? "ws://127.0.0.1:48710/wdp",
      client: opts.clientName ?? "pi-webdev-extension",
      ...(opts.clientVersion !== undefined ? { clientVersion: opts.clientVersion } : {}),
    });
    for (const tool of [pingTool(wdp)]) {
      host.registerTool(tool.name, tool.schema, tool.invoke);
    }
    return { wdp, close: () => wdp.close() };
  };
}
