/**
 * WDP (WebDev Protocol) wire types.
 *
 * Three message kinds share one envelope, distinguished structurally:
 *   - Command:  has `id` + `method` + `params`
 *   - Response: has `id` + (`result` xor `error`)
 *   - Event:    has `method` + `params`, NO `id`
 *
 * The shapes mirror CDP/JSON-RPC deliberately — see docs/03-protocol.html.
 */

export type WdpId = number;

export interface WdpCommand<P = unknown> {
  id: WdpId;
  method: string;
  params?: P;
}

export interface WdpSuccessResponse<R = unknown> {
  id: WdpId;
  result: R;
}

export interface WdpErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface WdpErrorResponse {
  id: WdpId;
  error: WdpErrorPayload;
}

export type WdpResponse<R = unknown> = WdpSuccessResponse<R> | WdpErrorResponse;

export interface WdpEvent<P = unknown> {
  method: string;
  params?: P;
}

export type WdpMessage =
  | WdpCommand
  | WdpSuccessResponse
  | WdpErrorResponse
  | WdpEvent;

export function isCommand(m: WdpMessage): m is WdpCommand {
  return "id" in m && "method" in m && !("result" in m) && !("error" in m);
}

export function isResponse(m: WdpMessage): m is WdpResponse {
  return "id" in m && ("result" in m || "error" in m);
}

export function isErrorResponse(m: WdpMessage): m is WdpErrorResponse {
  return "id" in m && "error" in m;
}

export function isEvent(m: WdpMessage): m is WdpEvent {
  return !("id" in m) && "method" in m;
}

/** Handshake — first command client → server. */
export interface InitializeParams {
  client: string;
  clientVersion?: string;
  supportedVersions: readonly string[];
  /** Optional working directory hint. Server may use it for project detection. */
  cwd?: string;
}

export interface InitializeResult {
  version: string;
  serverName: string;
  serverVersion: string;
  /** See ./capabilities.ts. */
  capabilities: import("./capabilities.js").ServerCapabilities;
}

/** Trivially round-trippable command used for liveness + handshake validation. */
export interface PingParams {
  echo?: string;
}
export interface PingResult {
  echo?: string;
  /** Server's monotonic time at receipt (ms). Useful for RTT measurement. */
  serverTime: number;
}
