import { WebSocket } from "ws";

import type { AgentHandler, MessageSender } from "./agent-handler.js";
import { ArtifactManager } from "./artifact-manager.js";
import type { UploadTracker } from "./upload-tracker.js";
import type {
  InvocationMessage,
  IncomingMessage,
  OutgoingMessage,
  ResultMessage,
} from "./types.js";
import { sleep } from "./utils.js";
import { createLogger, defaultLogger, type Logger } from "./logger.js";
import CommandHandler from "./command-handler.js";
import DownloadHandler from "./download-handler.js";

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
  private logger: Logger;
  private readonly downloadHandler: DownloadHandler;

  constructor(ws: WebSocket, config: SessionConfig) {
    this.ws = ws;
    this.config = config;
    this.logger = config.logger ?? defaultLogger;
    this.downloadHandler = new DownloadHandler(this.logger);
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
    this.logger = createLogger(message.source_id);
    this.config.uploadTracker.setLogger(this.logger);

    const artifactsDir = message.artifacts_dir;
    if (artifactsDir) {
      this.artifactManager = new ArtifactManager({
        artifactsDir,
        uploadTracker: this.config.uploadTracker,
        send: (msg) => this.send(msg),
      });
      this.artifactManager.setLogger(this.logger);
    }

    const outputFormat = JSON.parse(message.output_format_json_schema_str) as {
      type: "json_schema";
      schema: Record<string, unknown>;
    };
    const model = message.preferred_model;

    this.logger.log(`Received invocation: model=${model}`);

    try {
      if (message.runtime_environment_downloadables) {
        this.logger.log("Downloading runtime environment downloadables...");
        for (const downloadable of message.runtime_environment_downloadables) {
          await this.downloadHandler.download(
            downloadable.download_url,
            downloadable.working_dir,
          );
        }
      }
      if (message.pre_agent_invocation_commands) {
        for (const command of message.pre_agent_invocation_commands) {
          try {
            this.logger.log(
              `Executing command: ${command.command} in directory: ${command.cwd}`,
            );
            const commandHandler = new CommandHandler({
              command,
              logger: this.logger,
              abortController: this.abortController,
              onStdout: (stdout) =>
                this.send({
                  message_type: "assistant_message",
                  text_blocks: [stdout],
                }),
              onStderr: (stderr) =>
                this.send({
                  message_type: "assistant_message",
                  text_blocks: [stderr],
                }),
            });

            const result = await commandHandler.execute();
            if (result.exitCode !== 0) {
              this.logger.error(
                "Command failed with exit code:",
                result.exitCode,
              );
              this.send({
                message_type: "error_message",
                error: "Command failed with exit code: " + result.exitCode,
                metadata: {},
              });
              return;
            }
          } catch (error) {
            this.logger.error(
              "Error executing pre-agent invocation command:",
              error,
            );
            throw error;
          }
        }
      }

      const sender: MessageSender = {
        sendAssistantMessage: (textBlocks: string[]) => {
          this.send({
            message_type: "assistant_message",
            text_blocks: textBlocks,
          });
        },
        sendErrorMessage: (
          error: string,
          metadata?: Record<string, unknown>,
        ) => {
          this.send({
            message_type: "error_message",
            error,
            metadata: metadata ?? {},
          });
        },
      };

      const agentResult = await this.config.handler.run(
        {
          systemPrompt: message.system_prompt,
          userPrompt: message.user_prompt,
          outputFormat,
          model,
          secrets: message.secrets_to_redact,
          env: message.agent_env ?? {},
          signal: this.abortController.signal,
          logger: this.logger,
        },
        sender,
      );

      const resultMessage: ResultMessage = {
        message_type: "result_message",
        metadata: agentResult.metadata ?? {},
        structured_output: agentResult.structuredOutput,
      };
      this.logger.log("Sending result message:", JSON.stringify(resultMessage));
      this.send(resultMessage);
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
      this.ws.send(JSON.stringify(data));
    }
  }
}
