import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { WebSocket } from "ws";

const mockArtifactManager = {
  setLogger: vi.fn(),
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

function createSession() {
  const ws = new MockWebSocket();
  const uploadTracker = new UploadTracker();
  const config: SessionConfig = {
    handler: mockHandler,
    uploadTracker,
  };
  const session = new WebSocketSession(ws as any, config);
  return { session, ws, config, uploadTracker };
}

function sendMessage(ws: MockWebSocket, message: unknown) {
  ws.emit("message", Buffer.from(JSON.stringify(message)));
}

const INVOCATION_MSG = {
  message_type: "invocation_message" as const,
  source_id: "test-source-id",
  system_prompt: "You are a tester",
  user_prompt: "Test the login flow",
  secrets_to_redact: ["secret123"],
  artifacts_dir: "/tmp/artifacts",
  output_format_json_schema_str: JSON.stringify({
    type: "json_schema",
    schema: { type: "object" },
  }),
  preferred_model: "test-model",
};

describe("WebSocketSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockHandlerRun.mockResolvedValue({
      structuredOutput: { success: true },
      metadata: { duration_ms: 1000 },
    });

    mockArtifactManager.handleUploadResponse.mockResolvedValue(undefined);
    mockArtifactManager.waitForPendingRequests.mockResolvedValue(undefined);
    mockArtifactManager.stopWatching.mockResolvedValue(undefined);
    mockDownloadHandler.download.mockResolvedValue(undefined);
    mockCommandExecute.mockResolvedValue({ exitCode: 0 });
  });

  describe("lifecycle", () => {
    it("resolves when invocation finishes", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await done;
    });
  });

  describe("message routing", () => {
    it("rejects non-invocation messages before invocation", async () => {
      const { session, ws } = createSession();
      session.run();

      sendMessage(ws, { message_type: "cancel_message" });
      await tick();

      expectSentError(ws, "non-invocation message before invocation");
    });

    it("rejects duplicate invocation messages", async () => {
      let resolveAgent!: () => void;
      mockHandlerRun.mockImplementation(
        () =>
          new Promise((r) => {
            resolveAgent = () => r({ structuredOutput: { success: true } });
          }),
      );

      const { session, ws } = createSession();
      session.run();

      sendMessage(ws, INVOCATION_MSG);
      await tick();
      sendMessage(ws, INVOCATION_MSG);
      await tick();

      expectSentError(ws, "multiple invocation messages");

      resolveAgent();
    });

    it("delegates artifact upload responses to ArtifactManager", async () => {
      let resolveAgent!: () => void;
      mockHandlerRun.mockImplementation(
        () =>
          new Promise((r) => {
            resolveAgent = () => r({ structuredOutput: { success: true } });
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
      await done;
    });

    it("aborts and closes on cancel message", async () => {
      let resolveAgent!: () => void;
      mockHandlerRun.mockImplementation(
        () =>
          new Promise((r) => {
            resolveAgent = () => r({ structuredOutput: {} });
          }),
      );

      const { session, ws } = createSession();
      const done = session.run();

      sendMessage(ws, INVOCATION_MSG);
      await tick();

      sendMessage(ws, { message_type: "cancel_message" });
      await tick();

      expect(ws.close).toHaveBeenCalled();

      resolveAgent();
    });
  });

  describe("invocation", () => {
    it("calls handler.run with correct arguments", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await done;

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
        structuredOutput: { success: true, steps: ["step1"] },
        metadata: { duration_ms: 1000 },
      });

      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await done;

      const sent = parseSentMessages(ws);
      const result = sent.find((m) => m.message_type === "result_message");
      expect(result).toBeDefined();
      expect(result!.structured_output.success).toBe(true);
      expect(result!.metadata).toMatchObject({ duration_ms: 1000 });
    });

    it("sends error message when agent throws", async () => {
      mockHandlerRun.mockRejectedValueOnce(new Error("agent crashed"));

      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await done;

      expectSentError(ws, "agent crashed");
    });
  });

  describe("finalization", () => {
    it("stops the artifact watcher", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await done;

      expect(mockArtifactManager.stopWatching).toHaveBeenCalled();
    });

    it("waits for pending artifact requests", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await done;

      expect(mockArtifactManager.waitForPendingRequests).toHaveBeenCalledWith(
        60_000,
      );
    });

    it("closes the websocket after finalization", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, INVOCATION_MSG);
      await done;

      expect(ws.close).toHaveBeenCalled();
    });
  });

  describe("runtime environment downloadables", () => {
    it("downloads all runtime environment downloadables before running agent", async () => {
      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, {
        ...INVOCATION_MSG,
        runtime_environment_downloadables: [
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
      await done;

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
      await done;

      expect(mockDownloadHandler.download).not.toHaveBeenCalled();
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
      await done;

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
      await done;

      const sent = parseSentMessages(ws);
      const error = sent.find((m) => m.message_type === "error_message");
      expect(error).toBeDefined();
      expect(error!.error).toContain("Command failed with exit code: 1");
    });

    it("sends error and result messages when command execution throws", async () => {
      mockCommandExecute.mockRejectedValueOnce(new Error("spawn failed"));

      const { session, ws } = createSession();
      const done = session.run();
      sendMessage(ws, {
        ...INVOCATION_MSG,
        pre_agent_invocation_commands: [{ command: "bad-cmd" }],
      });
      await done;

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
      await done;

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
