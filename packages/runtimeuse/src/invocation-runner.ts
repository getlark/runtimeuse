import type { AgentHandler, MessageSender } from "./agent-handler.js";
import type {
  InvocationMessage,
  CommandExecutionMessage,
  CommandExecutionResultItem,
  CommandExecutionResultMessage,
  OutgoingMessage,
  ResultMessage,
  RuntimeEnvironmentDownloadable,
  Command,
} from "./types.js";
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

  async run(message: InvocationMessage): Promise<ResultMessage> {
    const { handler, logger, abortController } = this.config;

    await this.downloadRuntimeEnvironment(message.pre_agent_downloadables);
    await this.runCommands(
      message.pre_agent_invocation_commands,
      "pre-agent",
      message.secrets_to_redact,
    );

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
        env: message.agent_env,
        secrets: message.secrets_to_redact,
        signal: abortController.signal,
        logger,
      },
      sender,
    );

    await this.runCommands(
      message.post_agent_invocation_commands,
      "post-agent",
      message.secrets_to_redact,
    );

    return {
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
  }

  async runCommandsOnly(
    message: CommandExecutionMessage,
  ): Promise<CommandExecutionResultMessage> {
    const { logger } = this.config;

    await this.downloadRuntimeEnvironment(message.pre_execution_downloadables);

    const results: CommandExecutionResultItem[] = [];
    for (const command of message.commands) {
      const exitCode = await this.runCommandAndCollect(
        command,
        message.secrets_to_redact,
        results,
      );
      if (exitCode !== 0) {
        logger.log(
          `Command failed with exit code ${exitCode}, skipping remaining commands`,
        );
        break;
      }
    }

    return { message_type: "command_execution_result_message", results };
  }

  private async runCommandAndCollect(
    command: Command,
    secrets: string[],
    results: CommandExecutionResultItem[],
  ): Promise<number> {
    const { logger, abortController, send } = this.config;

    logger.log(
      `Executing command: ${command.command} in directory: ${command.cwd}`,
    );

    const onStdout = command.silent
      ? undefined
      : (stdout: string) =>
          send({ message_type: "assistant_message", text_blocks: [stdout] });
    const onStderr = command.silent
      ? undefined
      : (stderr: string) =>
          send({ message_type: "assistant_message", text_blocks: [stderr] });

    const handler = new CommandHandler({
      command,
      secrets,
      logger,
      abortController,
      onStdout,
      onStderr,
    });

    const result = await handler.execute();
    results.push({
      command: command.command,
      exit_code: result.exitCode,
      stdout: result.stdout,
    });
    return result.exitCode;
  }

  private async downloadRuntimeEnvironment(
    downloadables?: RuntimeEnvironmentDownloadable[],
  ): Promise<void> {
    if (!downloadables) return;

    this.config.logger.log("Downloading runtime environment downloadables...");
    for (const downloadable of downloadables) {
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
    secrets: string[],
  ): Promise<void> {
    if (!commands) return;

    const { logger, abortController, send } = this.config;

    for (const command of commands) {
      logger.log(
        `Executing ${phase} command: ${command.command} in directory: ${command.cwd}`,
      );

      const onStdout = command.silent
        ? undefined
        : (stdout: string) =>
            send({ message_type: "assistant_message", text_blocks: [stdout] });
      const onStderr = command.silent
        ? undefined
        : (stderr: string) =>
            send({ message_type: "assistant_message", text_blocks: [stderr] });

      const handler = new CommandHandler({
        command,
        secrets,
        logger,
        abortController,
        onStdout,
        onStderr,
      });

      const result = await handler.execute();
      if (result.exitCode !== 0) {
        const errorMsg = `${phase} command failed with exit code: ${result.exitCode}`;
        logger.error(errorMsg);
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
