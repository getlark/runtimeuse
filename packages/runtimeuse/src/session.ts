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
  private drainPromise: Promise<void> | null = null;

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
        await this.drain();
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
        // Drain the artifact watcher *before* closing so any late chokidar
        // events still have an open socket to send upload requests through.
        await this.drain();
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

    if (message.artifacts_dir) {
      this.ensureArtifactManager();
      this.artifactManager!.addDirectory(message.artifacts_dir);
    }

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
        if (abortController.signal.aborted) {
          // Runner may return a partial result after abort (e.g., a command
          // exits with a non-numeric code). Replace with a cancel terminal
          // so the client sees exactly one error_message for the cancelled
          // request, consistent with the throw path below.
          this.logger.log("Request aborted (runner returned); emitting cancel terminal.");
          terminal = {
            message_type: "error_message",
            error: "Request cancelled",
            metadata: {},
          };
        }
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

      // Settle any artifacts written by this request before sending the
      // terminal. Chokidar's awaitWriteFinish delays `add` events by ~2s,
      // and the server typically closes the socket immediately after we
      // respond — so artifacts requested *after* the terminal would never
      // get their upload response back. Wait for chokidar to catch up, then
      // wait for the upload round-trips we've queued.
      if (this.artifactManager) {
        const delayMs = this.config.postInvocationDelayMs ?? 3_000;
        if (delayMs > 0) {
          this.logger.log(`Waiting ${delayMs}ms for artifacts to settle...`);
          await sleep(delayMs);
        }
        await this.artifactManager.waitForPendingRequests(
          this.config.artifactWaitMs ?? 60_000,
        );
      }
      this.send(terminal);
    } finally {
      this.currentAbortController = null;
      this.requestInFlight = false;
    }
  }

  private drain(): Promise<void> {
    if (!this.drainPromise) {
      this.drainPromise = (async () => {
        const delayMs = this.config.postInvocationDelayMs ?? 3_000;
        if (this.artifactManager && delayMs > 0) {
          this.logger.log(`Waiting ${delayMs}ms for artifact watcher to drain...`);
          await sleep(delayMs);
        }
        await this.artifactManager?.stopWatching();
        await this.artifactManager?.waitForPendingRequests(
          this.config.artifactWaitMs ?? 60_000,
        );
        await this.config.uploadTracker.waitForAll(
          this.config.uploadTimeoutMs ?? 30_000,
        );
      })();
    }
    return this.drainPromise;
  }

  private ensureArtifactManager(): void {
    if (this.artifactManager) {
      this.artifactManager.setLogger(this.logger);
      return;
    }
    this.artifactManager = new ArtifactManager({
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
