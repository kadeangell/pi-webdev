/**
 * Error codes follow doc 03-protocol §3.7:
 *   -32xxx  protocol errors (client bug)
 *   1xxxx   tool errors      (LLM should adapt)
 *   2xxxx   transient errors (retry with backoff)
 *
 * JSON-RPC reserves -32000..-32099 for server-defined; we expand the
 * range to -32000..-32999 for WDP-defined protocol errors.
 */

export const ErrorCodes = {
  // -32xxx protocol
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  HandshakeRequired: -32001,
  UnsupportedProtocolVersion: -32002,
  AlreadyInitialized: -32003,

  // 1xxxx tool
  ToolError: 10000,
  CapabilityUnavailable: 10001,
  SubsystemNotReady: 10002,
  NotFound: 10100,
  InvalidArgument: 10200,

  // 2xxxx transient
  Timeout: 20000,
  SubsystemUnavailable: 20001,
  Overloaded: 20002,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class WdpError extends Error {
  override name = "WdpError";
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }

  toPayload() {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}
