import type { WebSocket } from "ws";
import {
  ErrorCodes,
  isCommand,
  isEvent,
  isResponse,
  type WdpEvent,
  type WdpMessage,
} from "@pi-webdev/shared-types";
import type { Dispatcher, HandlerContext } from "../dispatcher.js";

let nextConnectionId = 1;

/**
 * One open WebSocket = one WdpConnection. Owns per-client state
 * (handshake flag, optional session bag) and routes inbound commands
 * through the dispatcher.
 */
export class WdpConnection {
  readonly id: string;
  readonly state = new Map<string, unknown>();
  initialized = false;
  closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly dispatcher: Dispatcher,
    private readonly onClose: (c: WdpConnection) => void,
  ) {
    this.id = `c${nextConnectionId++}`;
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", () => this.handleClose());
    ws.on("error", () => this.handleClose());
  }

  /** Push a server-initiated event to this client. No id, no response expected. */
  emit<P>(method: string, params?: P): void {
    if (this.closed) return;
    const ev: WdpEvent<P> = params === undefined ? { method } : { method, params };
    this.send(ev);
  }

  close(reason?: string): void {
    if (this.closed) return;
    try {
      this.ws.close(1000, reason);
    } catch {
      // socket already torn down
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
  }

  private send(payload: WdpMessage): void {
    if (this.closed) return;
    this.ws.send(JSON.stringify(payload));
  }

  private async onMessage(raw: string): Promise<void> {
    let msg: WdpMessage;
    try {
      msg = JSON.parse(raw) as WdpMessage;
    } catch {
      // Parse errors have no id to correlate against, so we surface them as events.
      this.emit("$/error", {
        code: ErrorCodes.ParseError,
        message: "Failed to parse WDP message as JSON",
      });
      return;
    }

    if (!isCommand(msg)) {
      // The orchestration server is currently a pure responder; client-initiated
      // events/responses aren't part of v0. Anything else is a shape error.
      if (!isResponse(msg) && !isEvent(msg)) {
        this.emit("$/error", {
          code: ErrorCodes.InvalidRequest,
          message: "Message did not match any WDP shape",
        });
      }
      return;
    }

    const cmd = msg;
    const ctx: HandlerContext = {
      connectionId: this.id,
      initialized: this.initialized,
      state: this.state,
      markInitialized: () => {
        this.initialized = true;
      },
      emit: (method, params) => this.emit(method, params),
    };
    const outcome = await this.dispatcher.dispatch(cmd, ctx);
    if ("result" in outcome) {
      this.send({ id: cmd.id, result: outcome.result });
    } else {
      this.send({ id: cmd.id, error: outcome.error });
    }
  }
}
