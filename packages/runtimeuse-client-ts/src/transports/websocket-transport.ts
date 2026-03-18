import WebSocket from "ws";
import type { SendQueue } from "../send-queue.js";

export class WebSocketTransport {
  private wsUrl: string;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
  }

  async *call(
    sendQueue: SendQueue
  ): AsyncGenerator<Record<string, unknown>> {
    const ws = await this.connect();

    let senderRunning = true;
    const senderPromise = (async () => {
      while (senderRunning) {
        const message = await sendQueue.get();
        if (!senderRunning) {
          sendQueue.taskDone();
          break;
        }
        try {
          await new Promise<void>((resolve, reject) => {
            ws.send(JSON.stringify(message), (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
        } finally {
          sendQueue.taskDone();
        }
      }
    })();

    try {
      const messageQueue: Record<string, unknown>[] = [];
      let messageResolve: (() => void) | null = null;
      let closed = false;

      ws.on("message", (raw: WebSocket.RawData) => {
        try {
          const data = JSON.parse(raw.toString()) as Record<string, unknown>;
          messageQueue.push(data);
        } catch {
          messageQueue.push({ raw: raw.toString() });
        }
        if (messageResolve) {
          const r = messageResolve;
          messageResolve = null;
          r();
        }
      });

      ws.on("close", () => {
        closed = true;
        if (messageResolve) {
          const r = messageResolve;
          messageResolve = null;
          r();
        }
      });

      ws.on("error", () => {
        closed = true;
        if (messageResolve) {
          const r = messageResolve;
          messageResolve = null;
          r();
        }
      });

      while (true) {
        if (messageQueue.length > 0) {
          yield messageQueue.shift()!;
          continue;
        }
        if (closed) break;
        await new Promise<void>((resolve) => {
          messageResolve = resolve;
        });
      }
    } finally {
      senderRunning = false;
      sendQueue.put({}).then(() => sendQueue.taskDone());
      await senderPromise.catch(() => {});
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
    }
  }

  private connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, {
        handshakeTimeout: 60_000,
      });
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }
}
