import { describe, it, expect, vi } from "vitest";
import { RuntimeUseClient } from "./client.js";
import { AgentRuntimeError, CancelledException } from "./errors.js";
import { AsyncQueue } from "./async-queue.js";
import type { Transport } from "./transports/transport.js";
import type {
  QueryOptions,
  AssistantMessage,
  ArtifactUploadRequestMessage,
  ArtifactUploadResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class FakeTransport {
  readonly sent: Array<Record<string, unknown>> = [];

  constructor(private messages: Array<Record<string, unknown>>) {}

  call: Transport = (sendQueue) => {
    return this._run(sendQueue);
  };

  private async *_run(
    sendQueue: AsyncQueue<Record<string, unknown>>,
  ): AsyncIterable<Record<string, unknown>> {
    const drainController = new AbortController();
    const drainPromise = this._drainForever(
      sendQueue,
      drainController.signal,
    );
    try {
      for (const msg of this.messages) {
        yield msg;
      }
      await sendQueue.join();
    } finally {
      drainController.abort();
      await drainPromise.catch(() => {});
    }
  }

  private async _drainForever(
    sendQueue: AsyncQueue<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const item = await Promise.race([
          sendQueue.get(),
          new Promise<never>((_, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
        ]);
        this.sent.push(item);
        sendQueue.taskDone();
      } catch {
        break;
      }
    }
  }
}

const DEFAULT_PROMPT = "Do something.";

const silentLogger = {
  log: () => {},
  error: () => {},
  debug: () => {},
};

function makeQueryOptions(
  overrides: Partial<QueryOptions> = {},
): QueryOptions {
  return {
    system_prompt: "You are a good assistant.",
    model: "gpt-4o",
    logger: silentLogger,
    ...overrides,
  };
}

function fakeTransport(
  messages: Array<Record<string, unknown>>,
): [FakeTransport, RuntimeUseClient] {
  const transport = new FakeTransport(messages);
  const client = new RuntimeUseClient({ transport: transport.call });
  return [transport, client];
}

const TEXT_RESULT_MSG = {
  message_type: "result_message" as const,
  data: { type: "text" as const, text: "Hello, world!" },
  metadata: null,
};

const STRUCTURED_RESULT_MSG = {
  message_type: "result_message" as const,
  data: {
    type: "structured_output" as const,
    structured_output: { ok: true },
  },
  metadata: null,
};

// ---------------------------------------------------------------------------
// Result message
// ---------------------------------------------------------------------------

describe("ResultMessage", () => {
  it("returns structured output result", async () => {
    const resultMsg = {
      message_type: "result_message",
      data: {
        type: "structured_output",
        structured_output: { success: true },
      },
      metadata: { duration_ms: 50 },
    };
    const [, client] = fakeTransport([resultMsg]);

    const result = await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions({
        output_format_json_schema_str: '{"type":"object"}',
      }),
    );

    expect(result.data.type).toBe("structured_output");
    expect(
      (result.data as { type: "structured_output"; structured_output: Record<string, unknown> })
        .structured_output,
    ).toEqual({ success: true });
    expect(result.metadata).toEqual({ duration_ms: 50 });
  });

  it("returns text result", async () => {
    const resultMsg = {
      message_type: "result_message",
      data: { type: "text", text: "The answer is 42." },
      metadata: null,
    };
    const [, client] = fakeTransport([resultMsg]);

    const result = await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions(),
    );

    expect(result.data.type).toBe("text");
    expect((result.data as { type: "text"; text: string }).text).toBe(
      "The answer is 42.",
    );
  });

  it("throws AgentRuntimeError when no result received", async () => {
    const [, client] = fakeTransport([]);

    await expect(
      client.query(DEFAULT_PROMPT, makeQueryOptions()),
    ).rejects.toThrow(AgentRuntimeError);
    await expect(
      client.query(DEFAULT_PROMPT, makeQueryOptions()),
    ).rejects.toThrow("No result message received");
  });

  it("throws when result message is missing data field", async () => {
    const resultMsg = { message_type: "result_message" };
    const [, client] = fakeTransport([resultMsg]);

    await expect(
      client.query(DEFAULT_PROMPT, makeQueryOptions()),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Assistant message
// ---------------------------------------------------------------------------

describe("AssistantMessage", () => {
  it("dispatches assistant message to callback", async () => {
    const assistantMsg = {
      message_type: "assistant_message",
      text_blocks: ["Hello", "World"],
    };
    const [, client] = fakeTransport([assistantMsg, TEXT_RESULT_MSG]);
    const onAssistant = vi.fn<(msg: AssistantMessage) => Promise<void>>();
    onAssistant.mockResolvedValue(undefined);

    await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions({ on_assistant_message: onAssistant }),
    );

    expect(onAssistant).toHaveBeenCalledTimes(1);
    const received = onAssistant.mock.calls[0][0];
    expect(received.text_blocks).toEqual(["Hello", "World"]);
  });

  it("ignores assistant message without callback", async () => {
    const assistantMsg = {
      message_type: "assistant_message",
      text_blocks: ["ignored"],
    };
    const [, client] = fakeTransport([assistantMsg, TEXT_RESULT_MSG]);

    const result = await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions(),
    );

    expect(result.data.type).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// Error message
// ---------------------------------------------------------------------------

describe("ErrorMessage", () => {
  it("throws AgentRuntimeError on error message", async () => {
    const errorMsg = {
      message_type: "error_message",
      error: "something broke",
      metadata: { code: 500 },
    };
    const [, client] = fakeTransport([errorMsg]);

    try {
      await client.query(DEFAULT_PROMPT, makeQueryOptions());
      expect.fail("Expected AgentRuntimeError");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentRuntimeError);
      const runtimeErr = err as AgentRuntimeError;
      expect(runtimeErr.error).toBe("something broke");
      expect(runtimeErr.metadata).toEqual({ code: 500 });
    }
  });

  it("handles error without metadata", async () => {
    const errorMsg = {
      message_type: "error_message",
      error: "oops",
    };
    const [, client] = fakeTransport([errorMsg]);

    try {
      await client.query(DEFAULT_PROMPT, makeQueryOptions());
      expect.fail("Expected AgentRuntimeError");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentRuntimeError);
      const runtimeErr = err as AgentRuntimeError;
      expect(runtimeErr.error).toBe("oops");
      expect(runtimeErr.metadata).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Artifact upload handshake
// ---------------------------------------------------------------------------

describe("ArtifactUpload", () => {
  it("completes artifact upload handshake", async () => {
    const uploadRequest = {
      message_type: "artifact_upload_request_message",
      filename: "screenshot.png",
      filepath: "/tmp/screenshot.png",
    };
    const [transport, client] = fakeTransport([
      uploadRequest,
      TEXT_RESULT_MSG,
    ]);

    const onArtifact = async (
      req: ArtifactUploadRequestMessage,
    ): Promise<ArtifactUploadResult> => {
      expect(req.filename).toBe("screenshot.png");
      return {
        presigned_url: "https://s3.example.com/presigned",
        content_type: "image/png",
      };
    };

    await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions({
        artifacts_dir: "/tmp/artifacts",
        on_artifact_upload_request: onArtifact,
      }),
    );

    const responseMsgs = transport.sent.filter(
      (m) => m.message_type === "artifact_upload_response_message",
    );
    expect(responseMsgs).toHaveLength(1);
    const resp = responseMsgs[0];
    expect(resp.filename).toBe("screenshot.png");
    expect(resp.filepath).toBe("/tmp/screenshot.png");
    expect(resp.presigned_url).toBe("https://s3.example.com/presigned");
    expect(resp.content_type).toBe("image/png");
  });

  it("ignores artifact upload request without callback", async () => {
    const uploadRequest = {
      message_type: "artifact_upload_request_message",
      filename: "file.txt",
      filepath: "/tmp/file.txt",
    };
    const [, client] = fakeTransport([uploadRequest, TEXT_RESULT_MSG]);

    const result = await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions(),
    );
    expect(result.data.type).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("Cancellation", () => {
  it("raises CancelledException on abort", async () => {
    const fillerMsg = {
      message_type: "assistant_message",
      text_blocks: ["working..."],
    };
    const [, client] = fakeTransport([fillerMsg, fillerMsg]);

    const abortOnFirst = async () => {
      client.abort();
    };

    await expect(
      client.query(
        DEFAULT_PROMPT,
        makeQueryOptions({ on_assistant_message: abortOnFirst }),
      ),
    ).rejects.toThrow(CancelledException);
  });

  it("does not cancel without abort", async () => {
    const [, client] = fakeTransport([TEXT_RESULT_MSG]);

    const result = await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions(),
    );

    expect(result.data.type).toBe("text");
    expect((result.data as { type: "text"; text: string }).text).toBe(
      "Hello, world!",
    );
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("Timeout", () => {
  it("throws TimeoutError when timeout exceeded", async () => {
    const stallingTransport: Transport = async function* () {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      yield {};
    };
    const client = new RuntimeUseClient({ transport: stallingTransport });

    try {
      await client.query(
        DEFAULT_PROMPT,
        makeQueryOptions({ timeout: 0.05 }),
      );
      expect.fail("Expected TimeoutError");
    } catch (err) {
      expect((err as Error).name).toBe("TimeoutError");
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown / malformed messages
// ---------------------------------------------------------------------------

describe("UnknownMessages", () => {
  it("skips unknown message type", async () => {
    const unknownMsg = { message_type: "unknown_type", data: 123 };
    const [, client] = fakeTransport([unknownMsg, TEXT_RESULT_MSG]);

    const result = await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions(),
    );

    expect(result.data.type).toBe("text");
  });

  it("skips completely malformed message", async () => {
    const badMsg = { no_message_type_key: true };
    const [, client] = fakeTransport([badMsg, TEXT_RESULT_MSG]);

    const result = await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions(),
    );

    expect(result.data.type).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// Multiple messages in sequence
// ---------------------------------------------------------------------------

describe("MultipleMessages", () => {
  it("handles full message sequence", async () => {
    const messages = [
      { message_type: "assistant_message", text_blocks: ["Starting..."] },
      {
        message_type: "assistant_message",
        text_blocks: ["Still working..."],
      },
      {
        message_type: "result_message",
        data: {
          type: "structured_output",
          structured_output: { answer: 42 },
        },
        metadata: { duration_ms: 100 },
      },
    ];
    const [, client] = fakeTransport(messages);
    const onAssistant = vi.fn<(msg: AssistantMessage) => Promise<void>>();
    onAssistant.mockResolvedValue(undefined);

    const result = await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions({ on_assistant_message: onAssistant }),
    );

    expect(onAssistant).toHaveBeenCalledTimes(2);
    expect(result.data.type).toBe("structured_output");
    expect(
      (result.data as { type: "structured_output"; structured_output: Record<string, unknown> })
        .structured_output,
    ).toEqual({ answer: 42 });
  });
});

// ---------------------------------------------------------------------------
// Invocation message is sent to the transport
// ---------------------------------------------------------------------------

describe("InvocationSent", () => {
  it("sends invocation message to transport", async () => {
    const [transport, client] = fakeTransport([TEXT_RESULT_MSG]);

    await client.query(
      "Do something.",
      makeQueryOptions({ source_id: "capture-test" }),
    );

    const invocationMsgs = transport.sent.filter(
      (m) => m.message_type === "invocation_message",
    );
    expect(invocationMsgs).toHaveLength(1);
    expect(invocationMsgs[0].source_id).toBe("capture-test");
    expect(invocationMsgs[0].user_prompt).toBe("Do something.");
  });

  it("forwards schema when set", async () => {
    const [transport, client] = fakeTransport([STRUCTURED_RESULT_MSG]);

    await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions({
        output_format_json_schema_str: '{"type":"object"}',
      }),
    );

    const invocationMsgs = transport.sent.filter(
      (m) => m.message_type === "invocation_message",
    );
    expect(invocationMsgs[0].output_format_json_schema_str).toBe(
      '{"type":"object"}',
    );
  });

  it("sends null schema when omitted", async () => {
    const [transport, client] = fakeTransport([TEXT_RESULT_MSG]);

    await client.query(DEFAULT_PROMPT, makeQueryOptions());

    const invocationMsgs = transport.sent.filter(
      (m) => m.message_type === "invocation_message",
    );
    expect(invocationMsgs[0].output_format_json_schema_str).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("Constructor", () => {
  it("requires wsUrl or transport", () => {
    expect(() => new RuntimeUseClient()).toThrow(
      "Either wsUrl or transport must be provided",
    );
  });

  it("accepts wsUrl", () => {
    const client = new RuntimeUseClient({ wsUrl: "ws://localhost:8080" });
    expect(client).toBeDefined();
  });

  it("accepts transport", () => {
    const [, client] = fakeTransport([]);
    expect(client).toBeDefined();
  });

  it("validates artifacts_dir requires callback", () => {
    const [, client] = fakeTransport([TEXT_RESULT_MSG]);

    expect(
      client.query(
        DEFAULT_PROMPT,
        makeQueryOptions({ artifacts_dir: "/tmp/artifacts" }),
      ),
    ).rejects.toThrow("must be specified together");

    const dummyCb = async () => ({
      presigned_url: "https://example.com",
      content_type: "text/plain",
    });

    expect(
      client.query(
        DEFAULT_PROMPT,
        makeQueryOptions({ on_artifact_upload_request: dummyCb }),
      ),
    ).rejects.toThrow("must be specified together");
  });

  it("accepts artifacts_dir with callback together", async () => {
    const dummyCb = async () => ({
      presigned_url: "https://example.com",
      content_type: "text/plain",
    });
    const [, client] = fakeTransport([TEXT_RESULT_MSG]);

    const result = await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions({
        artifacts_dir: "/tmp/artifacts",
        on_artifact_upload_request: dummyCb,
      }),
    );
    expect(result.data.type).toBe("text");
  });
});
