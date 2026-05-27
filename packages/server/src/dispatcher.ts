import {
  ErrorCodes,
  WdpError,
  type WdpCommand,
  type WdpErrorPayload,
} from "@pi-webdev/shared-types";

export type MethodHandler<P = any, R = any> = (
  params: P,
  ctx: HandlerContext,
) => Promise<R> | R;

export interface HandlerContext {
  connectionId: string;
  /** Has the connection completed $/initialize? */
  initialized: boolean;
  /** Per-connection mutable bag handlers can read/write. */
  state: Map<string, unknown>;
  /** Flips the connection into the initialized state. */
  markInitialized: () => void;
  /** Server-pushed event for *this* connection. */
  emit: (method: string, params?: unknown) => void;
}

/**
 * Dispatches incoming commands to registered handlers. Stays transport-agnostic
 * so the server can swap WebSocket for stdio later without rewriting handlers.
 */
export class Dispatcher {
  private handlers = new Map<string, MethodHandler>();
  /** Methods that may be called before the handshake completes. */
  private preInitMethods = new Set<string>(["$/initialize", "$/ping"]);

  register<P = unknown, R = unknown>(method: string, handler: MethodHandler<P, R>): void {
    if (this.handlers.has(method)) {
      throw new Error(`Method already registered: ${method}`);
    }
    this.handlers.set(method, handler as MethodHandler);
  }

  allowBeforeInitialize(method: string): void {
    this.preInitMethods.add(method);
  }

  registeredMethods(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async dispatch(cmd: WdpCommand, ctx: HandlerContext): Promise<{ result: unknown } | { error: WdpErrorPayload }> {
    const handler = this.handlers.get(cmd.method);
    if (!handler) {
      return {
        error: { code: ErrorCodes.MethodNotFound, message: `Unknown method: ${cmd.method}` },
      };
    }
    if (!ctx.initialized && !this.preInitMethods.has(cmd.method)) {
      return {
        error: {
          code: ErrorCodes.HandshakeRequired,
          message: `Connection must call $/initialize before ${cmd.method}`,
        },
      };
    }

    try {
      const result = await handler(cmd.params ?? {}, ctx);
      return { result: result ?? null };
    } catch (err) {
      if (err instanceof WdpError) return { error: err.toPayload() };
      const message = err instanceof Error ? err.message : String(err);
      return { error: { code: ErrorCodes.InternalError, message } };
    }
  }
}
