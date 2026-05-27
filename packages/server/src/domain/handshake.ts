import {
  ErrorCodes,
  PROTOCOL_VERSION,
  WdpError,
  type InitializeParams,
  type InitializeResult,
  type PingParams,
  type PingResult,
  type ServerCapabilities,
} from "@pi-webdev/shared-types";
import type { Dispatcher, HandlerContext } from "../dispatcher.js";

const STATE_KEY = "handshake.clientInfo";

export interface HandshakeOptions {
  serverName: string;
  serverVersion: string;
  getCapabilities: () => Promise<ServerCapabilities> | ServerCapabilities;
}

/** Registers $/initialize and $/ping on the given dispatcher. */
export function registerHandshake(dispatcher: Dispatcher, opts: HandshakeOptions): void {
  dispatcher.register<InitializeParams, InitializeResult>("$/initialize", async (params, ctx) => {
    if (ctx.initialized) {
      throw new WdpError(ErrorCodes.AlreadyInitialized, "$/initialize called twice on same connection");
    }
    if (!params || !Array.isArray(params.supportedVersions)) {
      throw new WdpError(ErrorCodes.InvalidParams, "$/initialize requires supportedVersions: string[]");
    }
    if (!params.supportedVersions.some((v) => v === "0.x" || v === PROTOCOL_VERSION)) {
      throw new WdpError(
        ErrorCodes.UnsupportedProtocolVersion,
        `No mutually-supported protocol version (server ${PROTOCOL_VERSION}, client ${params.supportedVersions.join(",")})`,
      );
    }
    ctx.state.set(STATE_KEY, { client: params.client, clientVersion: params.clientVersion });
    ctx.markInitialized();
    return {
      version: PROTOCOL_VERSION,
      serverName: opts.serverName,
      serverVersion: opts.serverVersion,
      capabilities: await opts.getCapabilities(),
    };
  });

  dispatcher.register<PingParams, PingResult>("$/ping", (params) => {
    const echo = params?.echo;
    return echo === undefined
      ? { serverTime: Date.now() }
      : { echo, serverTime: Date.now() };
  });
}

/** Read the client metadata recorded during $/initialize. */
export function getClientInfo(ctx: HandlerContext): { client: string; clientVersion?: string } | undefined {
  return ctx.state.get(STATE_KEY) as { client: string; clientVersion?: string } | undefined;
}
