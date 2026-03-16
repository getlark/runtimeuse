import { WebSocket } from "ws";

import type { AgentHandler } from "./agent-handler.js";
import { ArtifactManager } from "./artifact-manager.js";
import type { UploadTracker } from "./upload-tracker.js";
import type { InvocationMessage, IncomingMessage, OutgoingMessage } from "./types.js";
import { redactSecrets, sleep } from "./utils.js";
import { createLogger, createRedactingLogger, defaultLogger, type Logger } from "./logger.js";
import { InvocationRunner } from "./invocation-runner.js";

export interface SessionConfig {
  handler: AgentHandler;
  uploadTracker: UploadTracker;
  uploadTimeoutMs?: number;
  artifactWaitMs?: number;
  postInvocationDelayMs?: number;
  logger?: Logger;
}

export class WebSocketSession {
  private readonly ws: WebSocket;
  private readonly config: SessionConfig;
  private readonly abortController = new AbortController();
  private artifactManager: ArtifactManager | null = null;
  private invocationReceived = false;
  private secrets: string[] = [];
  private logger: Logger;

  constructor(ws: WebSocket, config: SessionConfig) {
    this.ws = ws;
    this.config = config;
    this.logger = config.logger ?? defaultLogger;
  }

  run(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.ws.on("message", async (rawData) => {
        this.logger.log("Received new WS message");
        try {
          const message: IncomingMessage = JSON.parse(rawData.toString());
          await this.handleMessage(message, resolve);
        } catch (error) {
          this.logger.error("Error processing message:", error);
          this.send({
            message_type: "error_message",
            error: String(error),
            metadata: {},
          });

          // todo: maybe close ws on error since nothing will happen after?
        }
      });

      this.ws.on("close", async () => {
        this.logger.log("WebSocket connection closed");
        this.abortController.abort();
        await this.artifactManager?.stopWatching();
        await this.config.uploadTracker.waitForAll(
          this.config.uploadTimeoutMs ?? 30_000,
        );
        resolve();
      });

      this.ws.on("error", (error) => {
        this.logger.error("WebSocket error:", error);
      });
    });
  }

  private async handleMessage(
    message: IncomingMessage,
    resolve: () => void,
  ): Promise<void> {
    if (
      !this.invocationReceived &&
      message.message_type !== "invocation_message"
    ) {
      throw new Error(
        "Received non-invocation message before invocation message! Received: " +
        JSON.stringify(message),
      );
    }

    switch (message.message_type) {
      case "artifact_upload_response_message":
        try {
          await this.artifactManager?.handleUploadResponse(message);
        } catch (error) {
          this.logger.error("Error uploading artifact:", error);
          this.send({
            message_type: "error_message",
            error: String(error),
            metadata: {},
          });
        }
        break;

      case "cancel_message":
        this.logger.log("Received cancel message. Aborting agent execution...");
        this.abortController.abort();
        this.ws.close();
        break;

      case "invocation_message":
        if (this.invocationReceived) {
          throw new Error("Received multiple invocation messages!");
        }
        this.invocationReceived = true;
        await this.executeInvocation(message);
        if (process.env.NODE_ENV !== "test") {
          await sleep(this.config.postInvocationDelayMs ?? 3_000);
        }
        await this.finalize();
        resolve();
        break;
    }
  }

  private async executeInvocation(message: InvocationMessage): Promise<void> {
    const sourceId = message.source_id ?? crypto.randomUUID();
    this.secrets = message.secrets_to_redact ?? [];
    this.logger = createRedactingLogger(createLogger(sourceId), this.secrets);
    this.config.uploadTracker.setLogger(this.logger);
    this.logger.log(`Received invocation: model=${message.model}`);

    this.initArtifactManager(message.artifacts_dir);

    const runner = new InvocationRunner({
      handler: this.config.handler,
      logger: this.logger,
      abortController: this.abortController,
      send: (msg) => this.send(msg),
    });

    try {
      await runner.run(message);
    } catch (error) {
      if (this.abortController.signal.aborted) {
        this.ws.close();
        this.logger.log("Agent execution aborted.");
        return;
      }
      this.logger.error("Error in agent execution:", error);
      this.send({
        message_type: "error_message",
        error: error instanceof Error ? error.message : JSON.stringify(error),
        metadata: {},
      });
    }
  }

  private initArtifactManager(artifactsDir?: string): void {
    if (!artifactsDir) return;
    this.artifactManager = new ArtifactManager({
      artifactsDir,
      uploadTracker: this.config.uploadTracker,
      send: (msg) => this.send(msg),
    });
    this.artifactManager.setLogger(this.logger);
  }

  private async finalize(): Promise<void> {
    await this.artifactManager?.stopWatching();

    if (!this.abortController.signal.aborted) {
      await this.artifactManager?.waitForPendingRequests(
        this.config.artifactWaitMs ?? 60_000,
      );
    }

    await this.config.uploadTracker.waitForAll(
      this.config.uploadTimeoutMs ?? 30_000,
    );
    this.logger.log("All artifacts uploaded.");
    this.ws.close();
  }

  private send(data: OutgoingMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(redactSecrets(data, this.secrets)));
    }
  }
}
