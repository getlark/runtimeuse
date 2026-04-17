import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentHandler,
  AgentInvocation,
  AgentResult,
  MessageSender,
} from "./agent-handler.js";
import type { Logger } from "./logger.js";
import type { InvocationMessage, CommandExecutionMessage, OutgoingMessage } from "./types.js";
import CommandHandler from "./command-handler.js";
import { InvocationRunner } from "./invocation-runner.js";

const mockDownload =
  vi.fn<(downloadUrl: string, workingDir: string) => Promise<void>>();
const mockExecute =
  vi.fn<
    (options: {
      command: { command: string; cwd?: string };
      onStdout?: (stdout: string) => void;
      onStderr?: (stderr: string) => void;
    }) => Promise<{ exitCode: number }>
  >();

vi.mock("./download-handler.js", () => ({
  default: vi.fn().mockImplementation(function () {
    return { download: mockDownload };
  }),
}));

vi.mock("./command-handler.js", () => ({
  default: vi.fn().mockImplementation(function (options: unknown) {
    return {
      execute: () =>
        mockExecute(
          options as {
            command: {
              command: string;
              cwd?: string;
            };
            onStdout?: (stdout: string) => void;
            onStderr?: (stderr: string) => void;
          },
        ),
    };
  }),
}));

const mockHandlerRun =
  vi.fn<
    (invocation: AgentInvocation, sender: MessageSender) => Promise<AgentResult>
  >();

const BASE_INVOCATION_MESSAGE: InvocationMessage = {
  message_type: "invocation_message",
  source_id: "source-id",
  system_prompt: "system prompt",
  user_prompt: "user prompt",
  secrets_to_redact: ["api-key"],
  output_format_json_schema_str: JSON.stringify({
    type: "json_schema",
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
  }),
  model: "test-model",
};

function createRunner(overrides?: Partial<InvocationMessage>) {
  const logger: Logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const abortController = new AbortController();
  const send = vi.fn<(msg: OutgoingMessage) => void>();
  const handler: AgentHandler = { run: mockHandlerRun };
  const runner = new InvocationRunner({
    handler,
    logger,
    abortController,
    send,
  });

  return {
    runner,
    logger,
    send,
    abortController,
    message: { ...BASE_INVOCATION_MESSAGE, ...overrides },
  };
}

describe("InvocationRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownload.mockResolvedValue(undefined);
    mockExecute.mockResolvedValue({ exitCode: 0 });
    mockHandlerRun.mockResolvedValue({
      type: "structured_output",
      structuredOutput: { ok: true },
      metadata: { duration_ms: 12 },
    } as AgentResult);
  });

  it("calls handler with parsed output format", async () => {
    const { runner, message, abortController, logger, send } = createRunner();

    const result = await runner.run(message);

    expect(mockHandlerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: message.system_prompt,
        userPrompt: message.user_prompt,
        outputFormat: {
          type: "json_schema",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
        model: message.model,
        secrets: message.secrets_to_redact,
        signal: abortController.signal,
        logger,
      }),
      expect.objectContaining({
        sendAssistantMessage: expect.any(Function),
        sendErrorMessage: expect.any(Function),
      }),
    );

    expect(result).toEqual({
      message_type: "result_message",
      metadata: { duration_ms: 12 },
      data: { type: "structured_output", structured_output: { ok: true } },
    });
  });

  it("downloads, runs pre commands, invokes agent, then runs post commands", async () => {
    const events: string[] = [];
    mockDownload.mockImplementation(async () => {
      events.push("download");
    });
    mockExecute.mockImplementation(async (options) => {
      events.push(`command:${options.command.command}`);
      return { exitCode: 0 };
    });
    mockHandlerRun.mockImplementation(async () => {
      events.push("handler");
      return { type: "structured_output", structuredOutput: { ok: true } } as AgentResult;
    });

    const { runner, message } = createRunner({
      pre_agent_downloadables: [
        {
          download_url: "https://example.com/runtime.tar.gz",
          working_dir: "/tmp",
        },
      ],
      pre_agent_invocation_commands: [{ command: "echo pre", cwd: "/app" }],
      post_agent_invocation_commands: [{ command: "echo post", cwd: "/app" }],
    });

    await runner.run(message);

    expect(events).toEqual([
      "download",
      "command:echo pre",
      "handler",
      "command:echo post",
    ]);
  });

  it("returns agent result even when a post-agent command fails", async () => {
    mockHandlerRun.mockResolvedValueOnce({
      type: "text",
      text: "agent succeeded",
      metadata: { duration_ms: 5 },
    } as AgentResult);
    mockExecute.mockResolvedValueOnce({ exitCode: 7 });

    const { runner, message, send } = createRunner({
      output_format_json_schema_str: undefined,
      post_agent_invocation_commands: [{ command: "cleanup", cwd: "/app" }],
    });

    const result = await runner.run(message);

    expect(result).toEqual({
      message_type: "result_message",
      metadata: { duration_ms: 5 },
      data: { type: "text", text: "agent succeeded" },
    });
    // An error_message is emitted for the post-agent failure so the client is notified,
    // but the agent's result is still returned as the terminal.
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        message_type: "error_message",
        error: expect.stringContaining("post-agent command failed"),
      }),
    );
  });

  it("returns agent result even when a post-agent command throws", async () => {
    mockHandlerRun.mockResolvedValueOnce({
      type: "text",
      text: "agent succeeded",
    } as AgentResult);
    mockExecute.mockRejectedValueOnce(new Error("spawn failed"));

    const { runner, message } = createRunner({
      output_format_json_schema_str: undefined,
      post_agent_invocation_commands: [{ command: "cleanup" }],
    });

    const result = await runner.run(message);

    expect(result.message_type).toBe("result_message");
    expect((result as any).data.text).toBe("agent succeeded");
  });

  it("forwards command stdout and stderr through assistant messages", async () => {
    mockExecute.mockImplementation(async (options) => {
      options.onStdout?.("stdout data");
      options.onStderr?.("stderr data");
      return { exitCode: 0 };
    });

    const { runner, message, send } = createRunner({
      pre_agent_invocation_commands: [{ command: "echo hello", cwd: "/app" }],
    });

    await runner.run(message);

    expect(send).toHaveBeenCalledWith({
      message_type: "assistant_message",
      text_blocks: ["stdout data"],
    });
    expect(send).toHaveBeenCalledWith({
      message_type: "assistant_message",
      text_blocks: ["stderr data"],
    });
  });

  it("sends error message and throws when command exits non-zero", async () => {
    mockExecute.mockResolvedValueOnce({ exitCode: 2 });
    const { runner, message, send, logger } = createRunner({
      pre_agent_invocation_commands: [{ command: "false", cwd: "/app" }],
    });

    await expect(runner.run(message)).rejects.toThrow(
      "pre-agent command failed with exit code: 2",
    );

    expect(logger.error).toHaveBeenCalledWith(
      "pre-agent command failed with exit code: 2",
    );
    expect(send).toHaveBeenCalledWith({
      message_type: "error_message",
      error: "pre-agent command failed with exit code: 2",
      metadata: {},
    });
    expect(mockHandlerRun).not.toHaveBeenCalled();
  });

  it("uses sender methods from handler to emit assistant and error messages", async () => {
    mockHandlerRun.mockImplementation(async (_, sender) => {
      sender.sendAssistantMessage(["thinking"]);
      sender.sendErrorMessage("warn", { hint: "retry" });
      return { type: "structured_output", structuredOutput: { ok: true } } as AgentResult;
    });
    const { runner, message, send } = createRunner();

    await runner.run(message);

    expect(send).toHaveBeenCalledWith({
      message_type: "assistant_message",
      text_blocks: ["thinking"],
    });
    expect(send).toHaveBeenCalledWith({
      message_type: "error_message",
      error: "warn",
      metadata: { hint: "retry" },
    });
  });

  it("defaults result metadata to empty object when handler omits it", async () => {
    mockHandlerRun.mockResolvedValueOnce({
      type: "structured_output",
      structuredOutput: { ok: true },
    } as AgentResult);
    const { runner, message } = createRunner();

    const result = await runner.run(message);

    expect(result).toEqual({
      message_type: "result_message",
      metadata: {},
      data: { type: "structured_output", structured_output: { ok: true } },
    });
  });

  it("returns text result when handler returns text", async () => {
    mockHandlerRun.mockResolvedValueOnce({
      type: "text",
      text: "Hello, world!",
      metadata: { model: "test" },
    } as AgentResult);
    const { runner } = createRunner({
      output_format_json_schema_str: undefined,
    });

    const result = await runner.run({
      ...BASE_INVOCATION_MESSAGE,
      output_format_json_schema_str: undefined,
    });

    expect(result).toEqual({
      message_type: "result_message",
      metadata: { model: "test" },
      data: { type: "text", text: "Hello, world!" },
    });
  });

  it("passes undefined outputFormat when schema is omitted", async () => {
    mockHandlerRun.mockResolvedValueOnce({
      type: "text",
      text: "response",
    } as AgentResult);
    const { runner } = createRunner();

    await runner.run({
      ...BASE_INVOCATION_MESSAGE,
      output_format_json_schema_str: undefined,
    });

    expect(mockHandlerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        outputFormat: undefined,
      }),
      expect.any(Object),
    );
  });

  it("passes agent_env to handler as env", async () => {
    mockHandlerRun.mockResolvedValueOnce({
      type: "text",
      text: "done",
    } as AgentResult);
    const { runner } = createRunner({
      agent_env: { API_KEY: "secret", MODE: "test" },
      output_format_json_schema_str: undefined,
    });

    await runner.run({
      ...BASE_INVOCATION_MESSAGE,
      agent_env: { API_KEY: "secret", MODE: "test" },
      output_format_json_schema_str: undefined,
    });

    expect(mockHandlerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { API_KEY: "secret", MODE: "test" },
      }),
      expect.any(Object),
    );
  });

  it("passes undefined env when agent_env is not set", async () => {
    mockHandlerRun.mockResolvedValueOnce({
      type: "text",
      text: "done",
    } as AgentResult);
    const { runner } = createRunner();

    await runner.run({
      ...BASE_INVOCATION_MESSAGE,
      output_format_json_schema_str: undefined,
    });

    expect(mockHandlerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        env: undefined,
      }),
      expect.any(Object),
    );
  });

  it("passes pre-command env through to CommandHandler", async () => {
    const { runner, message } = createRunner({
      pre_agent_invocation_commands: [
        { command: "setup", cwd: "/app", env: { SETUP_VAR: "1" } },
      ],
    });

    await runner.run(message);

    expect(CommandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { command: "setup", cwd: "/app", env: { SETUP_VAR: "1" } },
      }),
    );
  });

  it("builds command handlers for each configured command", async () => {
    const { runner, message } = createRunner({
      pre_agent_invocation_commands: [
        { command: "echo 1", cwd: "/app" },
        { command: "echo 2", cwd: "/app" },
      ],
      post_agent_invocation_commands: [{ command: "echo 3", cwd: "/app" }],
    });

    await runner.run(message);

    expect(CommandHandler).toHaveBeenCalledTimes(3);
  });
});

const BASE_COMMAND_EXECUTION_MESSAGE: CommandExecutionMessage = {
  message_type: "command_execution_message",
  source_id: "source-id",
  secrets_to_redact: ["api-key"],
  commands: [{ command: "echo hello", cwd: "/app" }],
};

function createCommandRunner(overrides?: Partial<CommandExecutionMessage>) {
  const logger: Logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const abortController = new AbortController();
  const send = vi.fn<(msg: OutgoingMessage) => void>();
  const handler: AgentHandler = { run: mockHandlerRun };
  const runner = new InvocationRunner({
    handler,
    logger,
    abortController,
    send,
  });

  return {
    runner,
    logger,
    send,
    abortController,
    message: { ...BASE_COMMAND_EXECUTION_MESSAGE, ...overrides },
  };
}

describe("InvocationRunner.runCommandsOnly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownload.mockResolvedValue(undefined);
    mockExecute.mockResolvedValue({ exitCode: 0 });
  });

  it("returns command_execution_result_message on success", async () => {
    const { runner, message } = createCommandRunner();

    const result = await runner.runCommandsOnly(message);

    expect(result).toEqual({
      message_type: "command_execution_result_message",
      results: [{ command: "echo hello", exit_code: 0 }],
    });
    expect(mockHandlerRun).not.toHaveBeenCalled();
  });

  it("collects results for multiple commands", async () => {
    const { runner, message } = createCommandRunner({
      commands: [
        { command: "echo 1", cwd: "/app" },
        { command: "echo 2", cwd: "/app" },
      ],
    });

    const result = await runner.runCommandsOnly(message);

    expect(result).toEqual({
      message_type: "command_execution_result_message",
      results: [
        { command: "echo 1", exit_code: 0 },
        { command: "echo 2", exit_code: 0 },
      ],
    });
  });

  it("forwards stdout and stderr through assistant messages", async () => {
    mockExecute.mockImplementation(async (options) => {
      options.onStdout?.("stdout data");
      options.onStderr?.("stderr data");
      return { exitCode: 0 };
    });

    const { runner, message, send } = createCommandRunner();

    await runner.runCommandsOnly(message);

    expect(send).toHaveBeenCalledWith({
      message_type: "assistant_message",
      text_blocks: ["stdout data"],
    });
    expect(send).toHaveBeenCalledWith({
      message_type: "assistant_message",
      text_blocks: ["stderr data"],
    });
  });

  it("returns result with exit code when command exits non-zero", async () => {
    mockExecute.mockResolvedValueOnce({ exitCode: 2 });
    const { runner, message, send } = createCommandRunner();

    const result = await runner.runCommandsOnly(message);

    expect(result).toEqual({
      message_type: "command_execution_result_message",
      results: [{ command: "echo hello", exit_code: 2 }],
    });
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ message_type: "error_message" }),
    );
  });

  it("skips remaining commands after a non-zero exit code", async () => {
    mockExecute
      .mockResolvedValueOnce({ exitCode: 1 })
      .mockResolvedValueOnce({ exitCode: 0 });
    const { runner, message } = createCommandRunner({
      commands: [
        { command: "failing", cwd: "/app" },
        { command: "skipped", cwd: "/app" },
      ],
    });

    const result = await runner.runCommandsOnly(message);

    expect(result).toEqual({
      message_type: "command_execution_result_message",
      results: [{ command: "failing", exit_code: 1 }],
    });
  });

  it("passes command env through to CommandHandler", async () => {
    const { runner, message } = createCommandRunner({
      commands: [
        { command: "echo hello", cwd: "/app", env: { FOO: "bar" } },
      ],
    });

    await runner.runCommandsOnly(message);

    expect(CommandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { command: "echo hello", cwd: "/app", env: { FOO: "bar" } },
      }),
    );
  });

  it("downloads runtime environment before running commands", async () => {
    const events: string[] = [];
    mockDownload.mockImplementation(async () => {
      events.push("download");
    });
    mockExecute.mockImplementation(async (options) => {
      events.push(`command:${options.command.command}`);
      return { exitCode: 0 };
    });

    const { runner, message } = createCommandRunner({
      pre_execution_downloadables: [
        {
          download_url: "https://example.com/runtime.tar.gz",
          working_dir: "/tmp",
        },
      ],
    });

    await runner.runCommandsOnly(message);

    expect(events).toEqual(["download", "command:echo hello"]);
  });
});
