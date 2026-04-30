import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { WebSocket } from "ws";

const mockArtifactManager = {
  setLogger: vi.fn(),
  addDirectory: vi.fn(),
  handleUploadResponse: vi.fn().mockResolvedValue(undefined),
  waitForPendingRequests: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn().mockResolvedValue(undefined),
};

vi.mock("./artifact-manager.js", () => ({
  ArtifactManager: vi.fn().mockImplementation(function () {
    return mockArtifactManager;
  }),
}));

const mockDownloadHandler = {
  download: vi.fn().mockResolvedValue(undefined),
};

vi.mock("./download-handler.js", () => ({
  default: vi.fn().mockImplementation(function () {
    return mockDownloadHandler;
  }),
}));

const mockCommandExecute = vi.fn();

vi.mock("./command-handler.js", () => ({
  default: vi.fn().mockImplementation(function () {
    return { execute: mockCommandExecute };
  }),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      createWriteStream: vi.fn(() => ({
        write: vi.fn(),
        end: vi.fn(),
        close: vi.fn(),
      })),
    },
  };
});

import { WebSocketSession, type SessionConfig } from "./session.js";
import { UploadTracker } from "./upload-tracker.js";
import type {
  AgentHandler,
  AgentInvocation,
  AgentResult,
  MessageSender,
} from "./agent-handler.js";
import CommandHandler from "./command-handler.js";

const mockHandlerRun =
  vi.fn<
    (invocation: AgentInvocation, sender: MessageSender) => Promise<AgentResult>
  >();

const mockHandler: AgentHandler = {
  run: mockHandlerRun,
};

class MockWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  send = vi.fn();
  close = vi.fn(() => {
    if (this.readyState !== WebSocket.CLOSED) {
      this.readyState = WebSocket.CLOSED;
      this.emit("close");
    }
  });
}

function createSession(overrides: Partial<SessionConfig> = {}) {
  const ws = new MockWebSocket();
  const uploadTracker = new UploadTracker();
  const config: SessionConfig = {
    handler: mockHandler,
    uploadTracker,
    postInvocationDelayMs: 0,
    ...overrides,
  };
  const session = new WebSocketSession(ws as any, config);
  return { session, ws, config, uploadTracker };
}

function sendMessage(ws: MockWebSocket, message: unknown) {
  ws.emit("message", Buffer.from(JSON.stringify(message)));
}

async function waitForSentCount(
  ws: MockWebSocket,
  predicate: (m: any) => boolean,
  count = 1,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const sent = parseSentMessages(ws);
    if (sent.filter(predicate).length >= count) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Expected message never sent");
}

async function waitForTerminal(ws: MockWebSocket, count = 1): Promise<void> {
  const terminals = new Set([
    "result_message",
    "command_execution_result_message",
    "error_message",
  ]);
  await waitForSentCount(ws, (m) => terminals.has(m.message_type), count);
}

async function endSession(ws: MockWebSocket, done: Promise<void>): Promise<void> {
  sendMessage(ws, { message_type: "end_session_message" });
  await done;
}

const INVOCATION_MSG = {
  message_type: "invocation_message" as const,
  source_id: "test-source-id",
  system_prompt: "You are a tester",
  user_prompt: "Test the login flow",
  secrets_to_redact: ["secret123"],
  artifacts_dirs: ["/tmp/artifacts"],
  output_format_json_schema_str: JSON.stringify({
    type: "json_schema",
    schema: { type: "object" },
  }),
  model: "test-model",
};

describe("WebSocketSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHandlerRun.mockReset();
    mockCommandExecute.mockReset();

    mockHandlerRun.mockResolvedValue({
      type: "structured_output",
      structuredOutput: { success: true },
      metadata: { duration_ms: 1000 },
    } as AgentResult);

    mockArtifactManager.handleUploadResponse.mockResolvedValue(undefined);
    mockArtifactManager.waitForPendingRequests.mockResolvedValue(undefined);
    mockArtifactManager.stopWatching.mockResolvedValue(undefined);
    mockDownloadHandler.download.mockResolvedValue(undefined);
    mockCommandExecute.mockResolvedValue({ exitCode: 0 });
  });

  describe("lifecycle", () => {
    it("sends terminal after invocation finishes", async () => {
      const { ws } = createSession().session && createSession();
      // Fresh session for this test
    });

    it("resolves when end_session_message is received", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);
    });

    it("resolves when the socket closes", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);
      ws.close();
      await done;
    });
  });

  describe("message routing", () => {
    it("ignores cancel_message when no request is in flight", async () => {
      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, { message_type: "cancel_message" });
      await tick();

      const sent = parseSentMessages(ws);
      expect(sent.filter((m) => m.message_type === "error_message")).toHaveLength(0);

      await endSession(ws, done);
    });

    it("rejects a second request while one is in flight", async () => {
      let resolveAgent!: () => void;
      mockHandlerRun.mockImplementation(
        () =>
          new Promise((r) => {
            resolveAgent = () =>
              r({
                type: "structured_output",
                structuredOutput: { success: true },
              } as AgentResult);
          }),
      );

      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, INVOCATION_MSG);
      await tick();
      sendMessage(ws, INVOCATION_MSG);
      await tick();

      expectSentError(ws, "another is in flight");

      resolveAgent();
      await waitForTerminal(ws);
      await endSession(ws, done);
    });

    it("delegates artifact upload responses to ArtifactManager", async () => {
      let resolveAgent!: () => void;
      mockHandlerRun.mockImplementation(
        () =>
          new Promise((r) => {
            resolveAgent = () =>
              r({
                type: "structured_output",
                structuredOutput: { success: true },
              } as AgentResult);
          }),
      );

      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, INVOCATION_MSG);
      await tick();

      const uploadResponse = {
        message_type: "artifact_upload_response_message",
        filename: "shot.png",
        filepath: "/artifacts/shot.png",
        presigned_url: "https://s3.example.com/upload",
      };
      sendMessage(ws, uploadResponse);
      await tick();

      expect(mockArtifactManager.handleUploadResponse).toHaveBeenCalledWith(
        uploadResponse,
      );

      resolveAgent();
      await waitForTerminal(ws);
      await endSession(ws, done);
    });

    it("aborts in-flight request on cancel message without closing session", async () => {
      mockHandlerRun.mockImplementation(
        (_inv, _sender) =>
          new Promise((_resolve, reject) => {
            _inv.signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      );

      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, INVOCATION_MSG);
      await tick();

      sendMessage(ws, { message_type: "cancel_message" });
      await waitForTerminal(ws);

      // WS should still be open — session continues
      expect(ws.close).not.toHaveBeenCalled();

      await endSession(ws, done);
    });

    it("closes the websocket on end_session_message", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);
      sendMessage(ws, { message_type: "end_session_message" });
      await done;

      expect(ws.close).toHaveBeenCalled();
    });
  });

  describe("heartbeats", () => {
    it("sends heartbeat messages while a request is in flight", async () => {
      let resolveAgent!: () => void;
      mockHandlerRun.mockImplementation(
        () =>
          new Promise((r) => {
            resolveAgent = () =>
              r({
                type: "structured_output",
                structuredOutput: { success: true },
              } as AgentResult);
          }),
      );

      const { session, ws } = createSession({ heartbeatIntervalMs: 5 });
      const done = session.run();

      sendMessage(ws, INVOCATION_MSG);
      await waitForSentCount(ws, (m) => m.message_type === "heartbeat_message");

      const sent = parseSentMessages(ws);
      const heartbeat = sent.find((m) => m.message_type === "heartbeat_message");
      expect(heartbeat).toMatchObject({
        message_type: "heartbeat_message",
        phase: "request_in_flight",
      });
      expect(heartbeat!.elapsed_ms).toBeGreaterThanOrEqual(0);

      resolveAgent();
      await waitForTerminal(ws);
      await endSession(ws, done);
    });

    it("stops sending heartbeats after the terminal message", async () => {
      let resolveAgent!: () => void;
      mockHandlerRun.mockImplementation(
        () =>
          new Promise((r) => {
            resolveAgent = () =>
              r({
                type: "structured_output",
                structuredOutput: { success: true },
              } as AgentResult);
          }),
      );

      const { session, ws } = createSession({ heartbeatIntervalMs: 5 });
      const done = session.run();

      sendMessage(ws, INVOCATION_MSG);
      await waitForSentCount(ws, (m) => m.message_type === "heartbeat_message");
      resolveAgent();
      await waitForTerminal(ws);

      const heartbeatCount = parseSentMessages(ws).filter(
        (m) => m.message_type === "heartbeat_message",
      ).length;
      await new Promise((r) => setTimeout(r, 25));
      const laterHeartbeatCount = parseSentMessages(ws).filter(
        (m) => m.message_type === "heartbeat_message",
      ).length;
      expect(laterHeartbeatCount).toBe(heartbeatCount);

      await endSession(ws, done);
    });

    it("does not keep sending heartbeats after socket close aborts the request", async () => {
      mockHandlerRun.mockImplementation(
        (invocation) =>
          new Promise((_resolve, reject) => {
            invocation.signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          }),
      );

      const { session, ws } = createSession({ heartbeatIntervalMs: 5 });
      const done = session.run();

      sendMessage(ws, INVOCATION_MSG);
      await waitForSentCount(ws, (m) => m.message_type === "heartbeat_message");
      ws.close();
      await tick();

      const heartbeatCount = parseSentMessages(ws).filter(
        (m) => m.message_type === "heartbeat_message",
      ).length;
      await new Promise((r) => setTimeout(r, 25));
      const laterHeartbeatCount = parseSentMessages(ws).filter(
        (m) => m.message_type === "heartbeat_message",
      ).length;
      expect(laterHeartbeatCount).toBe(heartbeatCount);

      await done;
    });
  });

  describe("invocation", () => {
    it("calls handler.run with correct arguments", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      expect(mockHandlerRun).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: "You are a tester",
          userPrompt: "Test the login flow",
          outputFormat: { type: "json_schema", schema: { type: "object" } },
          model: "test-model",
          secrets: ["secret123"],
        }),
        expect.objectContaining({
          sendAssistantMessage: expect.any(Function),
          sendErrorMessage: expect.any(Function),
        }),
      );
    });

    it("sends result_message from handler result", async () => {
      mockHandlerRun.mockResolvedValue({
        type: "structured_output",
        structuredOutput: { success: true, steps: ["step1"] },
        metadata: { duration_ms: 1000 },
      } as AgentResult);

      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      const sent = parseSentMessages(ws);
      const result = sent.find((m) => m.message_type === "result_message");
      expect(result).toBeDefined();
      expect(result!.data.structured_output.success).toBe(true);
      expect(result!.metadata).toMatchObject({ duration_ms: 1000 });
    });

    it("sends error message when agent throws", async () => {
      mockHandlerRun.mockRejectedValueOnce(new Error("agent crashed"));

      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      expectSentError(ws, "agent crashed");
    });

    it("includes structured metadata when agent throws", async () => {
      const error = Object.assign(new Error("agent crashed"), {
        metadata: {
          handler: "claude",
          session_id: "abc123",
          stderr_tail: "permission denied",
        },
        code: "ERR_AGENT_CRASH",
      });
      mockHandlerRun.mockRejectedValueOnce(error);

      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      const sent = parseSentMessages(ws);
      const runtimeError = sent.find((m) => m.message_type === "error_message");
      expect(runtimeError).toBeDefined();
      expect(runtimeError!.metadata).toMatchObject({
        error_name: "Error",
        handler: "claude",
        session_id: "abc123",
      });
      expect(runtimeError!.metadata.error_details).toMatchObject({
        code: "ERR_AGENT_CRASH",
      });
    });
  });

  describe("finalization", () => {
    it("stops the artifact watcher on session close, not per request", async () => {
      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);

      // Watcher must still be running between requests.
      expect(mockArtifactManager.stopWatching).not.toHaveBeenCalled();

      await endSession(ws, done);

      expect(mockArtifactManager.stopWatching).toHaveBeenCalled();
    });

    it("waits for pending artifact requests on session close", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      expect(mockArtifactManager.waitForPendingRequests).toHaveBeenCalledWith(
        60_000,
      );
    });

    it("registers each request's artifacts_dirs on the shared watcher", async () => {
      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, { ...INVOCATION_MSG, artifacts_dirs: ["/tmp/first"] });
      await waitForTerminal(ws, 1);
      sendMessage(ws, { ...INVOCATION_MSG, artifacts_dirs: ["/tmp/second"] });
      await waitForTerminal(ws, 2);
      await endSession(ws, done);

      expect(mockArtifactManager.addDirectory).toHaveBeenCalledWith(
        "/tmp/first",
        expect.any(Object),
      );
      expect(mockArtifactManager.addDirectory).toHaveBeenCalledWith(
        "/tmp/second",
        expect.any(Object),
      );
    });

    it("registers every directory when a request lists multiple artifacts_dirs", async () => {
      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, {
        ...INVOCATION_MSG,
        artifacts_dirs: ["/tmp/a", "/tmp/b", "/tmp/c"],
      });
      await waitForTerminal(ws);
      await endSession(ws, done);

      expect(mockArtifactManager.addDirectory).toHaveBeenCalledWith(
        "/tmp/a",
        expect.any(Object),
      );
      expect(mockArtifactManager.addDirectory).toHaveBeenCalledWith(
        "/tmp/b",
        expect.any(Object),
      );
      expect(mockArtifactManager.addDirectory).toHaveBeenCalledWith(
        "/tmp/c",
        expect.any(Object),
      );
    });

    it("still accepts the deprecated singular artifacts_dir field", async () => {
      const { session, ws } = createSession();
      const done = session.run();

      const { artifacts_dirs: _omit, ...withoutPlural } = INVOCATION_MSG;
      sendMessage(ws, { ...withoutPlural, artifacts_dir: "/tmp/legacy" });
      await waitForTerminal(ws);
      await endSession(ws, done);

      expect(mockArtifactManager.addDirectory).toHaveBeenCalledWith(
        "/tmp/legacy",
        expect.any(Object),
      );
    });

    it("dedupes when both artifacts_dir and artifacts_dirs name the same path", async () => {
      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, {
        ...INVOCATION_MSG,
        artifacts_dir: "/tmp/shared",
        artifacts_dirs: ["/tmp/shared", "/tmp/extra"],
      });
      await waitForTerminal(ws);
      await endSession(ws, done);

      const sharedCalls = mockArtifactManager.addDirectory.mock.calls.filter(
        (c) => c[0] === "/tmp/shared",
      );
      expect(sharedCalls).toHaveLength(1);
      expect(mockArtifactManager.addDirectory).toHaveBeenCalledWith(
        "/tmp/extra",
        expect.any(Object),
      );
    });

    it("forwards artifacts_ignore_content to every addDirectory call", async () => {
      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, {
        ...INVOCATION_MSG,
        artifacts_dirs: ["/tmp/a", "/tmp/b"],
        artifacts_ignore_content: "*.log\nnode_modules/\n",
      });
      await waitForTerminal(ws);
      await endSession(ws, done);

      expect(mockArtifactManager.addDirectory).toHaveBeenCalledWith("/tmp/a", {
        ignoreContent: "*.log\nnode_modules/\n",
      });
      expect(mockArtifactManager.addDirectory).toHaveBeenCalledWith("/tmp/b", {
        ignoreContent: "*.log\nnode_modules/\n",
      });
    });

    it("passes empty options when artifacts_ignore_content is omitted", async () => {
      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, {
        ...INVOCATION_MSG,
        artifacts_dirs: ["/tmp/only"],
      });
      await waitForTerminal(ws);
      await endSession(ws, done);

      expect(mockArtifactManager.addDirectory).toHaveBeenCalledWith(
        "/tmp/only",
        {},
      );
    });

    it("treats artifacts_ignore_content: null as omitted (cross-language wire format)", async () => {
      // Other-language clients (e.g. Python's pydantic .model_dump) serialize
      // an unset Optional field as JSON null rather than omitting it. The
      // runtime must accept that without crashing the ignore parser.
      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, {
        ...INVOCATION_MSG,
        artifacts_dirs: ["/tmp/with-null"],
        artifacts_ignore_content: null,
      });
      await waitForTerminal(ws);
      await endSession(ws, done);

      expect(mockArtifactManager.addDirectory).toHaveBeenCalledWith(
        "/tmp/with-null",
        {},
      );
    });

    it("forwards artifacts_ignore_content from a command_execution_message", async () => {
      mockCommandExecute.mockResolvedValueOnce({ exitCode: 0 });
      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, {
        message_type: "command_execution_message",
        source_id: "cmd-test",
        secrets_to_redact: [],
        commands: [{ command: "echo hi" }],
        artifacts_dirs: ["/tmp/cmd-artifacts"],
        artifacts_ignore_content: "*.tmp\n",
      });
      await waitForTerminal(ws);
      await endSession(ws, done);

      expect(mockArtifactManager.addDirectory).toHaveBeenCalledWith(
        "/tmp/cmd-artifacts",
        { ignoreContent: "*.tmp\n" },
      );
    });
  });

  describe("runtime environment downloadables", () => {
    it("downloads all runtime environment downloadables before running agent", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, {
        ...INVOCATION_MSG,
        pre_agent_downloadables: [
          {
            download_url: "https://example.com/test.zip",
            working_dir: "/tmp/test",
          },
          {
            download_url: "https://example.com/data.tar.gz",
            working_dir: "/tmp/data",
          },
        ],
      });
      await waitForTerminal(ws);
      await endSession(ws, done);

      expect(mockDownloadHandler.download).toHaveBeenCalledTimes(2);
      expect(mockDownloadHandler.download).toHaveBeenCalledWith(
        "https://example.com/test.zip",
        "/tmp/test",
      );
      expect(mockDownloadHandler.download).toHaveBeenCalledWith(
        "https://example.com/data.tar.gz",
        "/tmp/data",
      );
    });

    it("does not download when no downloadables are provided", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      expect(mockDownloadHandler.download).not.toHaveBeenCalled();
    });
  });

  describe("secrets redaction", () => {
    it("redacts secrets from result messages", async () => {
      mockHandlerRun.mockResolvedValue({
        type: "text",
        text: "the key is secret123 here",
        metadata: { info: "secret123 leaked" },
      } as AgentResult);

      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      const sent = parseSentMessages(ws);
      const result = sent.find((m) => m.message_type === "result_message");
      expect(result).toBeDefined();
      expect(result!.data.text).toBe("the key is [REDACTED] here");
      expect(result!.metadata.info).toBe("[REDACTED] leaked");
    });

    it("redacts secrets from assistant messages", async () => {
      mockHandlerRun.mockImplementation(async (_inv, sender) => {
        sender.sendAssistantMessage(["password is secret123"]);
        return { type: "text", text: "done" } as AgentResult;
      });

      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      const sent = parseSentMessages(ws);
      const assistant = sent.find(
        (m) => m.message_type === "assistant_message",
      );
      expect(assistant).toBeDefined();
      expect(assistant!.text_blocks[0]).toBe("password is [REDACTED]");
    });

    it("redacts secrets from error messages", async () => {
      const error = Object.assign(new Error("crash with secret123 in trace"), {
        metadata: {
          stderr_tail: "secret123 appeared in stderr",
        },
      });
      mockHandlerRun.mockRejectedValueOnce(error);

      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      const sent = parseSentMessages(ws);
      const runtimeError = sent.find((m) => m.message_type === "error_message");
      expect(runtimeError).toBeDefined();
      expect(runtimeError!.error).not.toContain("secret123");
      expect(runtimeError!.error).toContain("[REDACTED]");
      expect(JSON.stringify(runtimeError!.metadata)).not.toContain("secret123");
      expect(JSON.stringify(runtimeError!.metadata)).toContain("[REDACTED]");
    });
  });

  describe("command execution message", () => {
    const COMMAND_EXEC_MSG = {
      message_type: "command_execution_message" as const,
      source_id: "test-source-id",
      secrets_to_redact: ["secret123"],
      commands: [{ command: "echo hello", cwd: "/app" }],
    };

    it("sends command_execution_result_message on success", async () => {
      mockCommandExecute.mockResolvedValueOnce({ exitCode: 0, stdout: "hello\n" });
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, COMMAND_EXEC_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      const sent = parseSentMessages(ws);
      const result = sent.find(
        (m) => m.message_type === "command_execution_result_message",
      );
      expect(result).toBeDefined();
      expect(result!.results).toEqual([
        { command: "echo hello", exit_code: 0, stdout: "hello\n" },
      ]);
    });

    it("does not invoke the agent handler", async () => {
      mockCommandExecute.mockResolvedValueOnce({ exitCode: 0 });
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, COMMAND_EXEC_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      expect(mockHandlerRun).not.toHaveBeenCalled();
    });

    it("returns result with exit code when command fails", async () => {
      mockCommandExecute.mockResolvedValueOnce({ exitCode: 1 });
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, COMMAND_EXEC_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      const sent = parseSentMessages(ws);
      const result = sent.find(
        (m) => m.message_type === "command_execution_result_message",
      );
      expect(result).toBeDefined();
      expect(result!.results[0].command).toBe("echo hello");
      expect(result!.results[0].exit_code).toBe(1);
      const errors = sent.filter((m) => m.message_type === "error_message");
      expect(errors).toHaveLength(0);
    });

    it("redacts secrets from command output", async () => {
      mockCommandExecute.mockImplementation(async function (this: any) {
        return { exitCode: 0 };
      });
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, COMMAND_EXEC_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      const sent = parseSentMessages(ws);
      for (const msg of sent) {
        expect(JSON.stringify(msg)).not.toContain("secret123");
      }
    });

    it("handles two sequential command_execution_messages on one socket", async () => {
      mockCommandExecute
        .mockResolvedValueOnce({ exitCode: 0, stdout: "first\n" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "second\n" });

      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, {
        ...COMMAND_EXEC_MSG,
        commands: [{ command: "echo first" }],
      });
      await waitForTerminal(ws, 1);

      sendMessage(ws, {
        ...COMMAND_EXEC_MSG,
        commands: [{ command: "echo second" }],
      });
      await waitForTerminal(ws, 2);

      const sent = parseSentMessages(ws);
      const results = sent.filter(
        (m) => m.message_type === "command_execution_result_message",
      );
      expect(results).toHaveLength(2);
      expect(results[0].results[0].command).toBe("echo first");
      expect(results[0].results[0].stdout).toBe("first\n");
      expect(results[1].results[0].command).toBe("echo second");
      expect(results[1].results[0].stdout).toBe("second\n");

      await endSession(ws, done);
    });
  });

  describe("pre-agent invocation commands", () => {
    it("continues to agent when pre-agent command exits with 0", async () => {
      mockCommandExecute.mockResolvedValueOnce({ exitCode: 0 });

      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, {
        ...INVOCATION_MSG,
        pre_agent_invocation_commands: [{ command: "npm test", cwd: "/app" }],
      });
      await waitForTerminal(ws);
      await endSession(ws, done);

      expect(mockHandlerRun).toHaveBeenCalled();
    });

    it("sends error message when pre-agent command exits with non-zero code", async () => {
      mockCommandExecute.mockResolvedValueOnce({
        exitCode: 1,
        error: new Error("test failed"),
      });

      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, {
        ...INVOCATION_MSG,
        pre_agent_invocation_commands: [{ command: "npm test", cwd: "/app" }],
      });
      await waitForTerminal(ws);
      await endSession(ws, done);

      const sent = parseSentMessages(ws);
      const error = sent.find((m) => m.message_type === "error_message");
      expect(error).toBeDefined();
      expect(error!.error).toContain("command failed with exit code: 1");
    });

    it("sends error and result messages when command execution throws", async () => {
      mockCommandExecute.mockRejectedValueOnce(new Error("spawn failed"));

      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, {
        ...INVOCATION_MSG,
        pre_agent_invocation_commands: [{ command: "bad-cmd" }],
      });
      await waitForTerminal(ws);
      await endSession(ws, done);

      const sent = parseSentMessages(ws);
      const errors = sent.filter((m) => m.message_type === "error_message");
      expect(errors.length).toBeGreaterThan(0);

      const error = sent.find((m) => m.message_type === "error_message");
      expect(error).toBeDefined();
      expect(error!.error).toContain("spawn failed");
    });

    it("runs agent normally when no pre-agent commands are provided", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await waitForTerminal(ws);
      await endSession(ws, done);

      expect(CommandHandler).not.toHaveBeenCalled();
      expect(mockHandlerRun).toHaveBeenCalled();
    });
  });
});

async function tick() {
  await new Promise((r) => setTimeout(r, 10));
}

function parseSentMessages(ws: MockWebSocket): Record<string, any>[] {
  return ws.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
}

function expectSentError(ws: MockWebSocket, substring: string) {
  const sent = parseSentMessages(ws);
  const errors = sent.filter((m) => m.message_type === "error_message");
  expect(errors.length).toBeGreaterThan(0);
  const match = errors.some((m) => m.error.includes(substring));
  expect(match).toBe(true);
}
