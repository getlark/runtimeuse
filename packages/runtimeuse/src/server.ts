import { WebSocketServer, WebSocket } from "ws";
import type { AgentHandler } from "./agent-handler.js";
import { WebSocketSession, type SessionConfig } from "./session.js";
import { UploadTracker } from "./upload-tracker.js";
import { defaultLogger, type Logger } from "./logger.js";

export interface RuntimeUseServerConfig {
  handler: AgentHandler;
  port?: number;
  uploadTimeoutMs?: number;
  artifactWaitMs?: number;
  postInvocationDelayMs?: number;
  logger?: Logger;
}

export class RuntimeUseServer {
  private readonly wss: WebSocketServer;
  private readonly config: RuntimeUseServerConfig;
  private readonly logger: Logger;

  constructor(config: RuntimeUseServerConfig) {
    this.config = config;
    this.logger = config.logger ?? defaultLogger;
    this.wss = new WebSocketServer({ port: config.port ?? 8080 });

    this.wss.on("connection", (ws: WebSocket) => {
      this.handleConnection(ws);
    });
  }

  private handleConnection(ws: WebSocket): void {
    const uploadTracker = new UploadTracker();
    const sessionConfig: SessionConfig = {
      handler: this.config.handler,
      uploadTracker,
      uploadTimeoutMs: this.config.uploadTimeoutMs,
      artifactWaitMs: this.config.artifactWaitMs,
      postInvocationDelayMs: this.config.postInvocationDelayMs,
      logger: this.config.logger,
    };
    const session = new WebSocketSession(ws, sessionConfig);
    session.run().catch((error) => {
      this.logger.error("Session error:", error);
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.on("listening", () => {
        this.logger.log(
          `RuntimeUse server listening on port ${this.config.port ?? 8080}`,
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
