import { WebSocket } from "ws";

import type { AgentHandler } from "./agent-handler.js";
import { ArtifactManager } from "./artifact-manager.js";
import type { UploadTracker } from "./upload-tracker.js";
import type { InvocationMessage, CommandExecutionMessage, IncomingMessage, OutgoingMessage } from "./types.js";
import { getErrorMessage, serializeErrorMetadata, redactError } from "./error-utils.js";
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
  onError?: (error: unknown, metadata: Record<string, unknown>) => void;
}

export class WebSocketSession {
  private readonly ws: WebSocket;
  private readonly config: SessionConfig;
  private readonly abortController = new AbortController();
  private artifactManager: ArtifactManager | null = null;
  private invocationReceived = false;
  private finalized = false;
  private cancelled = false;
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
          this.reportError(error, { phase: "message_parsing" });
          this.send({
            message_type: "error_message",
            error: getErrorMessage(error),
            metadata: serializeErrorMetadata(error),
          });
        }
      });

      this.ws.on("close", async (code, reason) => {
        if (!this.finalized && !this.cancelled) {
          this.logger.warn(
            `WebSocket closed unexpectedly (code=${code}, reason=${reason?.toString() ?? ""}). Artifacts may not have been fully uploaded.`,
          );
        }
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
        this.reportError(error, { phase: "websocket" });
      });
    });
  }

  private async handleMessage(
    message: IncomingMessage,
    resolve: () => void,
  ): Promise<void> {
    if (
      !this.invocationReceived &&
      message.message_type !== "invocation_message" &&
      message.message_type !== "command_execution_message"
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
          this.reportError(error, { phase: "artifact_upload" });
          this.send({
            message_type: "error_message",
            error: getErrorMessage(error),
            metadata: serializeErrorMetadata(error),
          });
        }
        break;

      case "cancel_message":
        this.logger.log("Received cancel message. Aborting agent execution...");
        this.cancelled = true;
        this.abortController.abort();
        this.ws.close();
        break;

      case "invocation_message":
        if (this.invocationReceived) {
          throw new Error("Received multiple invocation messages!");
        }
        this.invocationReceived = true;
        await this.executeInvocation(message);
        const hasArtifacts = this.artifactManager !== null;
        if (process.env.NODE_ENV !== "test" || hasArtifacts) {
          this.logger.log("Waiting for post-invocation delay...");
          await sleep(this.config.postInvocationDelayMs ?? 3_000);
        }
        await this.finalize();
        resolve();
        break;

      case "command_execution_message":
        if (this.invocationReceived) {
          throw new Error("Received multiple invocation messages!");
        }
        this.invocationReceived = true;
        await this.executeCommandsOnly(message);
        const hasCommandArtifacts = this.artifactManager !== null;
        if (process.env.NODE_ENV !== "test" || hasCommandArtifacts) {
          this.logger.log("Waiting for post-invocation delay...");
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
      this.reportError(error, {
        phase: "agent_execution",
        source_id: sourceId,
        model: message.model,
      });
      this.send({
        message_type: "error_message",
        error: getErrorMessage(error),
        metadata: serializeErrorMetadata(error),
      });
    }
  }

  private async executeCommandsOnly(message: CommandExecutionMessage): Promise<void> {
    const sourceId = message.source_id ?? crypto.randomUUID();
    this.secrets = message.secrets_to_redact ?? [];
    this.logger = createRedactingLogger(createLogger(sourceId), this.secrets);
    this.config.uploadTracker.setLogger(this.logger);
    this.logger.log("Received command execution request");

    this.initArtifactManager(message.artifacts_dir);

    const runner = new InvocationRunner({
      handler: this.config.handler,
      logger: this.logger,
      abortController: this.abortController,
      send: (msg) => this.send(msg),
    });

    try {
      await runner.runCommandsOnly(message);
    } catch (error) {
      if (this.abortController.signal.aborted) {
        this.ws.close();
        this.logger.log("Command execution aborted.");
        return;
      }
      this.logger.error("Error in command execution:", error);
      this.reportError(error, {
        phase: "command_execution",
        source_id: sourceId,
      });
      this.send({
        message_type: "error_message",
        error: getErrorMessage(error),
        metadata: serializeErrorMetadata(error),
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
    this.finalized = true;
    this.ws.close();
  }

  private reportError(error: unknown, context: Record<string, unknown> = {}): void {
    try {
      this.config.onError?.(
        redactError(error, this.secrets),
        redactSecrets({
          ...serializeErrorMetadata(error),
          ...context,
        }, this.secrets),
      );
    } catch {
      // onError must not propagate — swallow to protect the caller's catch block
    }
  }

  private send(data: OutgoingMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(redactSecrets(data, this.secrets)));
    }
  }
}
