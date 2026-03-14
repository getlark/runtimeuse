import type { AgentHandler, MessageSender } from "./agent-handler.js";
import type { InvocationMessage, OutgoingMessage } from "./types.js";
import type { Logger } from "./logger.js";
import CommandHandler from "./command-handler.js";
import DownloadHandler from "./download-handler.js";

export interface InvocationRunnerConfig {
  handler: AgentHandler;
  logger: Logger;
  abortController: AbortController;
  send: (msg: OutgoingMessage) => void;
}

export class InvocationRunner {
  private readonly config: InvocationRunnerConfig;
  private readonly downloadHandler: DownloadHandler;

  constructor(config: InvocationRunnerConfig) {
    this.config = config;
    this.downloadHandler = new DownloadHandler(config.logger);
  }

  async run(message: InvocationMessage): Promise<void> {
    const { handler, logger, abortController, send } = this.config;

    await this.downloadRuntimeEnvironment(message);
    await this.runCommands(message.pre_agent_invocation_commands, "pre-agent");

    const sender = this.createSender();
    const outputFormat = message.output_format_json_schema_str
      ? (JSON.parse(message.output_format_json_schema_str) as {
          type: "json_schema";
          schema: Record<string, unknown>;
        })
      : undefined;

    const agentResult = await handler.run(
      {
        systemPrompt: message.system_prompt,
        userPrompt: message.user_prompt,
        outputFormat,
        model: message.model,
        secrets: message.secrets_to_redact,
        signal: abortController.signal,
        logger,
      },
      sender,
    );

    const resultMessage: OutgoingMessage = {
      message_type: "result_message",
      metadata: agentResult.metadata ?? {},
      data:
        agentResult.type === "text"
          ? { type: "text", text: agentResult.text }
          : {
              type: "structured_output",
              structured_output: agentResult.structuredOutput,
            },
    };

    logger.log("Sending result message:", JSON.stringify(resultMessage));
    send(resultMessage);

    await this.runCommands(
      message.post_agent_invocation_commands,
      "post-agent",
    );
  }

  private async downloadRuntimeEnvironment(
    message: InvocationMessage,
  ): Promise<void> {
    if (!message.pre_agent_downloadables) return;

    this.config.logger.log("Downloading runtime environment downloadables...");
    for (const downloadable of message.pre_agent_downloadables) {
      await this.downloadHandler.download(
        downloadable.download_url,
        downloadable.working_dir,
      );
    }
  }

  private async runCommands(
    commands:
      | InvocationMessage["pre_agent_invocation_commands"]
      | InvocationMessage["post_agent_invocation_commands"],
    phase: string,
  ): Promise<void> {
    if (!commands) return;

    const { logger, abortController, send } = this.config;

    for (const command of commands) {
      logger.log(
        `Executing ${phase} command: ${command.command} in directory: ${command.cwd}`,
      );

      const handler = new CommandHandler({
        command,
        logger,
        abortController,
        onStdout: (stdout) =>
          send({ message_type: "assistant_message", text_blocks: [stdout] }),
        onStderr: (stderr) =>
          send({ message_type: "assistant_message", text_blocks: [stderr] }),
      });

      const result = await handler.execute();
      if (result.exitCode !== 0) {
        const errorMsg = `${phase} command failed with exit code: ${result.exitCode}`;
        logger.error(errorMsg);
        send({ message_type: "error_message", error: errorMsg, metadata: {} });
        throw new Error(errorMsg);
      }
    }
  }

  private createSender(): MessageSender {
    const { send } = this.config;
    return {
      sendAssistantMessage: (textBlocks: string[]) =>
        send({ message_type: "assistant_message", text_blocks: textBlocks }),
      sendErrorMessage: (error: string, metadata?: Record<string, unknown>) =>
        send({
          message_type: "error_message",
          error,
          metadata: metadata ?? {},
        }),
    };
  }
}
