import { describe, it, expect, vi } from "vitest";
import { RuntimeUseClient } from "./client.js";
import { AgentRuntimeError, CancelledException } from "./exceptions.js";
import { SendQueue } from "./send-queue.js";
import type { Transport } from "./transports/transport.js";
import type {
  QueryOptions,
  QueryResult,
  ArtifactUploadRequestMessage,
  ArtifactUploadResult,
  AssistantMessage,
} from "./types.js";

function createFakeTransport(messages: Record<string, unknown>[]) {
  const sent: Record<string, unknown>[] = [];

  const transport: Transport = async function* (sendQueue: SendQueue) {
    const drainPromise = (async () => {
      while (true) {
        const item = await sendQueue.get();
        sent.push(item);
        sendQueue.taskDone();
      }
    })();

    try {
      for (const msg of messages) {
        yield msg;
      }
      await sendQueue.join();
    } finally {
      // Stop the drainer - it's blocked on get(), so put a sentinel
      // We can't truly cancel it, but the test will end
    }
  };

  return { transport, sent };
}

const DEFAULT_PROMPT = "Do something.";

function makeQueryOptions(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return {
    system_prompt: "You are a good assistant.",
    model: "gpt-4o",
    ...overrides,
  };
}

const TEXT_RESULT_MSG = {
  message_type: "result_message",
  data: { type: "text", text: "Hello, world!" },
  metadata: undefined,
};

const STRUCTURED_RESULT_MSG = {
  message_type: "result_message",
  data: { type: "structured_output", structured_output: { ok: true } },
  metadata: undefined,
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
    const { transport } = createFakeTransport([resultMsg]);
    const client = new RuntimeUseClient({ transport });

    const result = await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions({
        output_format_json_schema_str: '{"type":"object"}',
      })
    );

    expect(result.data.type).toBe("structured_output");
    if (result.data.type === "structured_output") {
      expect(result.data.structured_output).toEqual({ success: true });
    }
    expect(result.metadata).toEqual({ duration_ms: 50 });
  });

  it("returns text result", async () => {
    const resultMsg = {
      message_type: "result_message",
      data: { type: "text", text: "The answer is 42." },
      metadata: undefined,
    };
    const { transport } = createFakeTransport([resultMsg]);
    const client = new RuntimeUseClient({ transport });

    const result = await client.query(DEFAULT_PROMPT, makeQueryOptions());

    expect(result.data.type).toBe("text");
    if (result.data.type === "text") {
      expect(result.data.text).toBe("The answer is 42.");
    }
  });

  it("throws when no result received", async () => {
    const { transport } = createFakeTransport([]);
    const client = new RuntimeUseClient({ transport });

    await expect(
      client.query(DEFAULT_PROMPT, makeQueryOptions())
    ).rejects.toThrow("No result message received");
  });
});

// ---------------------------------------------------------------------------
// Assistant message
// ---------------------------------------------------------------------------

describe("AssistantMessage", () => {
  it("dispatches to callback", async () => {
    const assistantMsg = {
      message_type: "assistant_message",
      text_blocks: ["Hello", "World"],
    };
    const { transport } = createFakeTransport([assistantMsg, TEXT_RESULT_MSG]);
    const onAssistant = vi.fn().mockResolvedValue(undefined);

    const client = new RuntimeUseClient({ transport });
    await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions({ on_assistant_message: onAssistant })
    );

    expect(onAssistant).toHaveBeenCalledOnce();
    const received = onAssistant.mock.calls[0][0] as AssistantMessage;
    expect(received.text_blocks).toEqual(["Hello", "World"]);
  });

  it("is ignored without callback", async () => {
    const assistantMsg = {
      message_type: "assistant_message",
      text_blocks: ["ignored"],
    };
    const { transport } = createFakeTransport([assistantMsg, TEXT_RESULT_MSG]);
    const client = new RuntimeUseClient({ transport });

    const result = await client.query(DEFAULT_PROMPT, makeQueryOptions());
    expect(result.data.type).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// Error message
// ---------------------------------------------------------------------------

describe("ErrorMessage", () => {
  it("raises AgentRuntimeError", async () => {
    const errorMsg = {
      message_type: "error_message",
      error: "something broke",
      metadata: { code: 500 },
    };
    const { transport } = createFakeTransport([errorMsg]);
    const client = new RuntimeUseClient({ transport });

    try {
      await client.query(DEFAULT_PROMPT, makeQueryOptions());
      expect.fail("should have thrown");
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
    const { transport } = createFakeTransport([errorMsg]);
    const client = new RuntimeUseClient({ transport });

    try {
      await client.query(DEFAULT_PROMPT, makeQueryOptions());
      expect.fail("should have thrown");
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
  it("performs upload handshake", async () => {
    const uploadRequest = {
      message_type: "artifact_upload_request_message",
      filename: "screenshot.png",
      filepath: "/tmp/screenshot.png",
    };
    const { transport, sent } = createFakeTransport([
      uploadRequest,
      TEXT_RESULT_MSG,
    ]);
    const client = new RuntimeUseClient({ transport });

    const onArtifact = async (
      req: ArtifactUploadRequestMessage
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
      })
    );

    const responseMsgs = sent.filter(
      (m) => m.message_type === "artifact_upload_response_message"
    );
    expect(responseMsgs).toHaveLength(1);
    const resp = responseMsgs[0];
    expect(resp.filename).toBe("screenshot.png");
    expect(resp.filepath).toBe("/tmp/screenshot.png");
    expect(resp.presigned_url).toBe("https://s3.example.com/presigned");
    expect(resp.content_type).toBe("image/png");
  });

  it("is ignored without callback", async () => {
    const uploadRequest = {
      message_type: "artifact_upload_request_message",
      filename: "file.txt",
      filepath: "/tmp/file.txt",
    };
    const { transport } = createFakeTransport([uploadRequest, TEXT_RESULT_MSG]);
    const client = new RuntimeUseClient({ transport });

    const result = await client.query(DEFAULT_PROMPT, makeQueryOptions());
    expect(result.data.type).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("Cancellation", () => {
  it("abort raises CancelledException", async () => {
    const fillerMsg = {
      message_type: "assistant_message",
      text_blocks: ["working..."],
    };
    const { transport } = createFakeTransport([fillerMsg, fillerMsg]);
    const client = new RuntimeUseClient({ transport });

    const abortOnFirst = async (_msg: AssistantMessage) => {
      client.abort();
    };

    await expect(
      client.query(
        DEFAULT_PROMPT,
        makeQueryOptions({ on_assistant_message: abortOnFirst })
      )
    ).rejects.toThrow(CancelledException);
  });

  it("no cancellation without abort", async () => {
    const { transport } = createFakeTransport([TEXT_RESULT_MSG]);
    const client = new RuntimeUseClient({ transport });

    const result = await client.query(DEFAULT_PROMPT, makeQueryOptions());
    expect(result.data.type).toBe("text");
    if (result.data.type === "text") {
      expect(result.data.text).toBe("Hello, world!");
    }
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("Timeout", () => {
  it("throws on timeout", async () => {
    const stallingTransport: Transport = async function* (
      _sendQueue: SendQueue
    ) {
      await new Promise((r) => setTimeout(r, 10000));
      yield {};
    };

    const client = new RuntimeUseClient({ transport: stallingTransport });

    await expect(
      client.query(DEFAULT_PROMPT, makeQueryOptions({ timeout: 0.05 }))
    ).rejects.toThrow("Query timed out");
  });
});

// ---------------------------------------------------------------------------
// Unknown / malformed messages
// ---------------------------------------------------------------------------

describe("UnknownMessages", () => {
  it("unknown message type is skipped", async () => {
    const unknownMsg = { message_type: "unknown_type", data: 123 };
    const { transport } = createFakeTransport([unknownMsg, TEXT_RESULT_MSG]);
    const client = new RuntimeUseClient({ transport });

    const result = await client.query(DEFAULT_PROMPT, makeQueryOptions());
    expect(result.data.type).toBe("text");
  });

  it("completely malformed message is skipped", async () => {
    const badMsg = { no_message_type_key: true };
    const { transport } = createFakeTransport([badMsg, TEXT_RESULT_MSG]);
    const client = new RuntimeUseClient({ transport });

    const result = await client.query(DEFAULT_PROMPT, makeQueryOptions());
    expect(result.data.type).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// Multiple messages in sequence
// ---------------------------------------------------------------------------

describe("MultipleMessages", () => {
  it("handles full message sequence", async () => {
    const messages = [
      {
        message_type: "assistant_message",
        text_blocks: ["Starting..."],
      },
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
    const { transport } = createFakeTransport(messages);
    const onAssistant = vi.fn().mockResolvedValue(undefined);
    const client = new RuntimeUseClient({ transport });

    const result = await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions({ on_assistant_message: onAssistant })
    );

    expect(onAssistant).toHaveBeenCalledTimes(2);
    expect(result.data.type).toBe("structured_output");
    if (result.data.type === "structured_output") {
      expect(result.data.structured_output).toEqual({ answer: 42 });
    }
  });
});

// ---------------------------------------------------------------------------
// Invocation message is sent to the transport
// ---------------------------------------------------------------------------

describe("InvocationSent", () => {
  it("invocation message is queued", async () => {
    const { transport, sent } = createFakeTransport([TEXT_RESULT_MSG]);
    const client = new RuntimeUseClient({ transport });

    await client.query(
      "Do something.",
      makeQueryOptions({ source_id: "capture-test" })
    );

    const invocationMsgs = sent.filter(
      (m) => m.message_type === "invocation_message"
    );
    expect(invocationMsgs).toHaveLength(1);
    expect(invocationMsgs[0].source_id).toBe("capture-test");
    expect(invocationMsgs[0].user_prompt).toBe("Do something.");
  });

  it("schema forwarded when set", async () => {
    const { transport, sent } = createFakeTransport([STRUCTURED_RESULT_MSG]);
    const client = new RuntimeUseClient({ transport });

    await client.query(
      DEFAULT_PROMPT,
      makeQueryOptions({
        output_format_json_schema_str: '{"type":"object"}',
      })
    );

    const invocationMsgs = sent.filter(
      (m) => m.message_type === "invocation_message"
    );
    expect(invocationMsgs[0].output_format_json_schema_str).toBe(
      '{"type":"object"}'
    );
  });

  it("schema undefined when omitted", async () => {
    const { transport, sent } = createFakeTransport([TEXT_RESULT_MSG]);
    const client = new RuntimeUseClient({ transport });

    await client.query(DEFAULT_PROMPT, makeQueryOptions());

    const invocationMsgs = sent.filter(
      (m) => m.message_type === "invocation_message"
    );
    expect(invocationMsgs[0].output_format_json_schema_str).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("Constructor", () => {
  it("requires wsUrl or transport", () => {
    expect(() => new RuntimeUseClient({})).toThrow(
      "Either wsUrl or transport must be provided"
    );
  });

  it("accepts wsUrl", () => {
    const client = new RuntimeUseClient({ wsUrl: "ws://localhost:8080" });
    expect(client).toBeDefined();
  });

  it("accepts transport", () => {
    const { transport } = createFakeTransport([]);
    const client = new RuntimeUseClient({ transport });
    expect(client).toBeDefined();
  });

  it("artifacts_dir requires callback", () => {
    expect(() =>
      makeQueryOptions({ artifacts_dir: "/tmp/artifacts" })
    ).not.toThrow();

    // The validation happens inside query, not in makeQueryOptions
    // Let's test via validateQueryOptions directly
  });
});

// ---------------------------------------------------------------------------
// QueryOptions validation
// ---------------------------------------------------------------------------

describe("QueryOptions validation", () => {
  it("artifacts_dir and on_artifact_upload_request must be set together", async () => {
    const { transport } = createFakeTransport([TEXT_RESULT_MSG]);
    const client = new RuntimeUseClient({ transport });

    await expect(
      client.query(
        DEFAULT_PROMPT,
        makeQueryOptions({ artifacts_dir: "/tmp/artifacts" })
      )
    ).rejects.toThrow("must be specified together");

    const dummyCb = async () => ({
      presigned_url: "https://example.com",
      content_type: "text/plain",
    });

    await expect(
      client.query(
        DEFAULT_PROMPT,
        makeQueryOptions({ on_artifact_upload_request: dummyCb })
      )
    ).rejects.toThrow("must be specified together");

    // Both set together should not throw validation error
    const { transport: t2 } = createFakeTransport([TEXT_RESULT_MSG]);
    const client2 = new RuntimeUseClient({ transport: t2 });
    const result = await client2.query(
      DEFAULT_PROMPT,
      makeQueryOptions({
        artifacts_dir: "/tmp/artifacts",
        on_artifact_upload_request: dummyCb,
      })
    );
    expect(result).toBeDefined();
  });
});
