import { WebSocket } from "ws";

import type { AgentHandler } from "./agent-handler.js";
import { ArtifactManager } from "./artifact-manager.js";
import type { UploadTracker } from "./upload-tracker.js";
import type {
  InvocationMessage,
  CommandExecutionMessage,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";
import { getErrorMessage, serializeErrorMetadata } from "./error-utils.js";
import { redactSecrets, sleep } from "./utils.js";
import {
  createLogger,
  createRedactingLogger,
  defaultLogger,
  type Logger,
} from "./logger.js";
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
  private currentAbortController: AbortController | null = null;
  private artifactManager: ArtifactManager | null = null;
  private requestInFlight = false;
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
          await this.handleMessage(message);
        } catch (error) {
          this.logger.error("Error processing message:", error);
          this.send({
            message_type: "error_message",
            error: getErrorMessage(error),
            metadata: serializeErrorMetadata(error),
          });
        }
      });

      this.ws.on("close", async (code, reason) => {
        if (this.requestInFlight) {
          this.logger.warn(
            `WebSocket closed unexpectedly mid-request (code=${code}, reason=${reason?.toString() ?? ""}). Artifacts may not have been fully uploaded.`,
          );
        }
        this.logger.log("WebSocket connection closed");
        this.currentAbortController?.abort();
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

  private async handleMessage(message: IncomingMessage): Promise<void> {
    switch (message.message_type) {
      case "end_session_message":
        this.logger.log("Received end_session_message. Closing session.");
        this.ws.close();
        return;

      case "cancel_message":
        this.logger.log(
          "Received cancel message. Aborting in-flight request...",
        );
        this.currentAbortController?.abort();
        return;

      case "artifact_upload_response_message":
        try {
          await this.artifactManager?.handleUploadResponse(message);
        } catch (error) {
          this.logger.error("Error uploading artifact:", error);
          this.send({
            message_type: "error_message",
            error: getErrorMessage(error),
            metadata: serializeErrorMetadata(error),
          });
        }
        return;

      case "invocation_message":
        if (this.requestInFlight) {
          throw new Error("Received request while another is in flight!");
        }
        await this.handleRequest((runner) => runner.run(message), message);
        return;

      case "command_execution_message":
        if (this.requestInFlight) {
          throw new Error("Received request while another is in flight!");
        }
        await this.handleRequest(
          (runner) => runner.runCommandsOnly(message),
          message,
        );
        return;
    }
  }

  private async handleRequest(
    runFn: (runner: InvocationRunner) => Promise<OutgoingMessage>,
    message: InvocationMessage | CommandExecutionMessage,
  ): Promise<void> {
    const abortController = new AbortController();
    this.currentAbortController = abortController;

    const sourceId = message.source_id ?? crypto.randomUUID();
    this.secrets = message.secrets_to_redact ?? [];
    this.logger = createRedactingLogger(createLogger(sourceId), this.secrets);
    this.config.uploadTracker.setLogger(this.logger);
    this.logger.log("Handling new request");

    this.initArtifactManager(message.artifacts_dir);

    const runner = new InvocationRunner({
      handler: this.config.handler,
      logger: this.logger,
      abortController,
      send: (msg) => this.send(msg),
    });

    let terminal: OutgoingMessage;
    try {
      this.requestInFlight = true;
      try {
        terminal = await runFn(runner);
      } catch (error) {
        if (abortController.signal.aborted) {
          this.logger.log("Request aborted.");
          terminal = {
            message_type: "error_message",
            error: "Request cancelled",
            metadata: {},
          };
        } else {
          this.logger.error("Error in request execution:", error);
          terminal = {
            message_type: "error_message",
            error: getErrorMessage(error),
            metadata: serializeErrorMetadata(error),
          };
        }
      }

      const hasArtifacts = this.artifactManager !== null;
      if (process.env.NODE_ENV !== "test" || hasArtifacts) {
        this.logger.log("Waiting for post-invocation delay...");
        await sleep(this.config.postInvocationDelayMs ?? 3_000);
      }

      try {
        await this.artifactManager?.stopWatching();
        if (!abortController.signal.aborted) {
          await this.artifactManager?.waitForPendingRequests(
            this.config.artifactWaitMs ?? 60_000,
          );
        }
        await this.config.uploadTracker.waitForAll(
          this.config.uploadTimeoutMs ?? 30_000,
        );
      } catch (error) {
        this.logger.error("Error draining request artifacts:", error);
      }
      this.logger.log("Request artifacts drained.");

      this.send(terminal);
    } finally {
      this.artifactManager = null;
      this.currentAbortController = null;
      this.requestInFlight = false;
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

  private send(data: OutgoingMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(redactSecrets(data, this.secrets)));
    }
  }
}
