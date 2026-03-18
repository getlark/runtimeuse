import WebSocket from "ws";
import { AsyncQueue } from "../async-queue.js";
import type { Transport } from "./transport.js";

/**
 * Transport that communicates over a WebSocket connection.
 */
export class WebSocketTransport {
  private readonly wsUrl: string;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  call: Transport = (sendQueue) => {
    return this._connect(sendQueue);
  };

  private async *_connect(
    sendQueue: AsyncQueue<Record<string, unknown>>,
  ): AsyncIterable<Record<string, unknown>> {
    const ws = await this._openSocket();

    const senderController = new AbortController();
    const senderPromise = this._queueSender(
      ws,
      sendQueue,
      senderController.signal,
    );

    try {
      yield* this._receiveMessages(ws);
    } finally {
      senderController.abort();
      await senderPromise.catch(() => {});
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
    }
  }

  private _openSocket(): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, {
        handshakeTimeout: 60_000,
      });
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  private async *_receiveMessages(
    ws: WebSocket,
  ): AsyncIterable<Record<string, unknown>> {
    const incoming: Array<Record<string, unknown>> = [];
    let resolve: (() => void) | null = null;
    let done = false;

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(String(raw));
        incoming.push(data);
      } catch {
        incoming.push({ raw: String(raw) });
      }
      resolve?.();
    });

    ws.on("close", () => {
      done = true;
      resolve?.();
    });

    ws.on("error", () => {
      done = true;
      resolve?.();
    });

    while (!done) {
      if (incoming.length > 0) {
        yield incoming.shift()!;
        continue;
      }
      await new Promise<void>((r) => {
        resolve = r;
      });
      resolve = null;
    }

    while (incoming.length > 0) {
      yield incoming.shift()!;
    }
  }

  private async _queueSender(
    ws: WebSocket,
    sendQueue: AsyncQueue<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      const message = await Promise.race([
        sendQueue.get(),
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      ]);
      try {
        ws.send(JSON.stringify(message));
      } finally {
        sendQueue.taskDone();
      }
    }
  }
}
