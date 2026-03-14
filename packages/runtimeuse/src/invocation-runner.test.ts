import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentHandler,
  AgentInvocation,
  AgentResult,
  MessageSender,
} from "./agent-handler.js";
import type { Logger } from "./logger.js";
import type { InvocationMessage, OutgoingMessage } from "./types.js";
import CommandHandler from "./command-handler.js";
import { InvocationRunner } from "./invocation-runner.js";

const mockDownload =
  vi.fn<(downloadUrl: string, workingDir: string) => Promise<void>>();
const mockExecute =
  vi.fn<
    (options: {
      command: { command: string; cwd?: string; env?: Record<string, string> };
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
              env?: Record<string, string>;
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

  it("calls handler with parsed output format and defaults env to empty object", async () => {
    const { runner, message, abortController, logger, send } = createRunner();

    await runner.run(message);

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

    expect(send).toHaveBeenCalledWith({
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
    const { runner, message, send } = createRunner();

    await runner.run(message);

    expect(send).toHaveBeenCalledWith({
      message_type: "result_message",
      metadata: {},
      data: { type: "structured_output", structured_output: { ok: true } },
    });
  });

  it("sends text result when handler returns text", async () => {
    mockHandlerRun.mockResolvedValueOnce({
      type: "text",
      text: "Hello, world!",
      metadata: { model: "test" },
    } as AgentResult);
    const { runner, send } = createRunner({
      output_format_json_schema_str: undefined,
    });

    await runner.run({
      ...BASE_INVOCATION_MESSAGE,
      output_format_json_schema_str: undefined,
    });

    expect(send).toHaveBeenCalledWith({
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
