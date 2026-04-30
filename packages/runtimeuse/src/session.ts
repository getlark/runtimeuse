import { WebSocket } from "ws";

import type { AgentHandler } from "./agent-handler.js";
import {
  ArtifactManager,
  type AddDirectoryOptions,
} from "./artifact-manager.js";
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
  heartbeatIntervalMs?: number;
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
        this.logger.log("Received end_session_message. Draining before confirm.");
        // Drain artifacts *before* acknowledging so late chokidar events
        // still have an open socket to send upload requests through. The
        // client is expected to keep the socket open — processing any late
        // artifact_upload_request_messages — until it receives our
        // end_session_confirm_message.
        await this.drain();
        this.send({ message_type: "end_session_confirm_message" });
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

    // Watched directories accumulate across requests on a persistent session:
    // chokidar's awaitWriteFinish + async upload may flush files written near
    // the end of one request well into the next, and we want to capture those.
    const artifactDirSpecs = this.collectArtifactDirSpecs(message);
    if (artifactDirSpecs.length > 0) {
      this.ensureArtifactManager();
      for (const spec of artifactDirSpecs) {
        this.artifactManager!.addDirectory(spec.dir, spec.options);
      }
    }

    const runner = new InvocationRunner({
      handler: this.config.handler,
      logger: this.logger,
      abortController,
      send: (msg) => this.send(msg),
    });

    let terminal: OutgoingMessage;
    const startedAt = Date.now();
    const heartbeatIntervalMs = this.config.heartbeatIntervalMs ?? 15_000;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    try {
      this.requestInFlight = true;
      if (heartbeatIntervalMs > 0) {
        heartbeatTimer = setInterval(() => {
          this.send({
            message_type: "heartbeat_message",
            phase: "request_in_flight",
            elapsed_ms: Date.now() - startedAt,
          });
        }, heartbeatIntervalMs);
      }
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

      // The artifact watcher stays alive for the whole session, so we no
      // longer block each request on a 3s drain. Artifacts that finish
      // writing after the terminal will still fire chokidar events and be
      // uploaded; on session close we do a single drain for any that were
      // written right before the ws closed.
      this.send(terminal);
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
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

  private collectArtifactDirSpecs(
    message: InvocationMessage | CommandExecutionMessage,
  ): Array<{ dir: string; options: AddDirectoryOptions }> {
    const dirs: string[] = [];
    if (message.artifacts_dir) {
      this.logger.warn(
        "artifacts_dir is deprecated; use artifacts_dirs (string[]) instead.",
      );
      dirs.push(message.artifacts_dir);
    }
    if (message.artifacts_dirs) {
      dirs.push(...message.artifacts_dirs);
    }
    const ignoreContent = message.artifacts_ignore_content;
    const options: AddDirectoryOptions =
      ignoreContent !== undefined ? { ignoreContent } : {};
    return [...new Set(dirs)].map((dir) => ({ dir, options }));
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
