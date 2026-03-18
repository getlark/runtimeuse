# runtimeuse (TypeScript)

TypeScript client library for communicating with a [runtimeuse](https://github.com/getlark/runtimeuse) agent runtime over WebSocket.

Handles the WebSocket connection lifecycle, message dispatch, artifact upload handshake, cancellation, and structured result parsing -- so you can focus on what to do with agent results rather than wire protocol details.

## Installation

```bash
npm install runtimeuse-client
```

## Quick Start

Start the runtime inside any sandbox, then connect from outside:

```typescript
import {
  AssistantMessage,
  QueryOptions,
  RuntimeEnvironmentDownloadable,
  RuntimeUseClient,
  StructuredOutputResult,
  TextResult,
} from "runtimeuse-client";

const WORKDIR = "/runtimeuse";

async function main() {
  // Start the runtime in a sandbox (provider-specific)
  const sandbox = Sandbox.create();
  sandbox.run("npx -y runtimeuse");
  const wsUrl = sandbox.getUrl(8080);

  const client = new RuntimeUseClient({ wsUrl });

  const onAssistant = async (msg: AssistantMessage): Promise<void> => {
    for (const block of msg.text_blocks) {
      console.log(`[assistant] ${block}`);
    }
  };

  // Text response (no output schema)
  const result = await client.query(
    "Summarize the contents of the codex repository and list your favorite file.",
    {
      system_prompt: "You are a helpful assistant.",
      model: "gpt-4.1",
      on_assistant_message: onAssistant,
      pre_agent_downloadables: [
        {
          download_url:
            "https://github.com/openai/codex/archive/refs/heads/main.zip",
          working_dir: WORKDIR,
        },
      ],
    },
  );

  if (result.data.type === "text") {
    console.log(result.data.text);
  }

  // Structured response (with output schema)
  const structured = await client.query(
    "Inspect the codex repository and return the total file count and total character count as JSON.",
    {
      system_prompt: "You are a helpful assistant.",
      model: "gpt-4.1",
      pre_agent_downloadables: [
        {
          download_url:
            "https://github.com/openai/codex/archive/refs/heads/main.zip",
          working_dir: WORKDIR,
        },
      ],
      output_format_json_schema_str: JSON.stringify({
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            file_count: { type: "integer" },
            char_count: { type: "integer" },
          },
          required: ["file_count", "char_count"],
          additionalProperties: false,
        },
      }),
    },
  );

  if (structured.data.type === "structured_output") {
    console.log(structured.data.structured_output);
  }
  console.log(structured.metadata);
}

main();
```

For local development without a sandbox, connect directly:

```typescript
const client = new RuntimeUseClient({ wsUrl: "ws://localhost:8080" });
```

## Usage

### RuntimeUseClient

Manages the WebSocket connection to the agent runtime and runs the message loop: sends a prompt, iterates the response stream, and returns a `QueryResult`. Raises `AgentRuntimeError` if the runtime returns an error.

`query()` returns a `QueryResult` with `.data` (a `TextResult` or `StructuredOutputResult`) and `.metadata`.

```typescript
const client = new RuntimeUseClient({ wsUrl: "ws://localhost:8080" });

const result = await client.query(
  "Summarize the contents of the codex repository.",
  {
    system_prompt: "You are a helpful assistant.",
    model: "gpt-4.1",
    pre_agent_downloadables: [downloadable],          // optional
    output_format_json_schema_str: "...",              // optional -- omit for text response
    on_assistant_message: onAssistant,                 // optional
    on_artifact_upload_request: onArtifact,            // optional -- return ArtifactUploadResult
    timeout: 300,                                      // optional -- seconds
  },
);

if (result.data.type === "text") {
  console.log(result.data.text);
} else {
  console.log(result.data.structured_output);
}

console.log(result.metadata); // execution metadata
```

### Artifact Upload Handshake

When the agent runtime requests an artifact upload, provide a callback that returns a presigned URL and content type. The client sends the response back automatically.

```typescript
import { ArtifactUploadRequestMessage, ArtifactUploadResult } from "runtimeuse-client";

async function onArtifact(
  request: ArtifactUploadRequestMessage,
): Promise<ArtifactUploadResult> {
  const presignedUrl = await myStorage.createPresignedUrl(request.filename);
  const contentType = guessContentType(request.filename);
  return { presigned_url: presignedUrl, content_type: contentType };
}
```

When using artifact uploads, set both `artifacts_dir` and `on_artifact_upload_request` in `QueryOptions`; the client validates that they are provided together.

### Cancellation

Call `client.abort()` to cancel a running query. The client sends a cancel message to the runtime and `query` throws `CancelledException`.

```typescript
import { CancelledException } from "runtimeuse-client";

async function cancelAfterDelay(client: RuntimeUseClient, seconds: number) {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  client.abort();
}

try {
  cancelAfterDelay(client, 30); // fire-and-forget
  const result = await client.query("Do the thing.", {
    system_prompt: "You are a helpful assistant.",
    model: "gpt-4.1",
  });
} catch (err) {
  if (err instanceof CancelledException) {
    console.log("Run was cancelled");
  }
}
```

### Custom Transport

You can provide a custom transport instead of the default WebSocket transport:

```typescript
import { AsyncQueue, RuntimeUseClient, Transport } from "runtimeuse-client";

const myTransport: Transport = async function* (
  sendQueue: AsyncQueue<Record<string, unknown>>,
) {
  // Custom transport implementation
  // Yield incoming messages, read outgoing messages from sendQueue
};

const client = new RuntimeUseClient({ transport: myTransport });
```

## API Reference

### Types

| Type                             | Description                                                        |
| -------------------------------- | ------------------------------------------------------------------ |
| `QueryOptions`                   | Configuration for `client.query()` (prompt options, callbacks, timeout) |
| `QueryResult`                    | Return type of `query()` (`.data`, `.metadata`)                    |
| `ResultMessage`                  | Wire-format result message from the runtime                        |
| `TextResult`                     | Result variant when no output schema is specified (`.text`)        |
| `StructuredOutputResult`         | Result variant when an output schema is specified (`.structured_output`) |
| `AssistantMessage`               | Intermediate assistant text messages                               |
| `ArtifactUploadRequestMessage`   | Runtime requesting a presigned URL for artifact upload             |
| `ArtifactUploadResponseMessage`  | Response with presigned URL sent back to runtime                   |
| `ErrorMessage`                   | Error from the agent runtime                                       |
| `Command`                        | Pre/post invocation shell command                                  |
| `RuntimeEnvironmentDownloadable` | File to download into the runtime before invocation                |
| `Transport`                      | Transport interface for custom implementations                     |

### Classes

| Class                | Description                                 |
| -------------------- | ------------------------------------------- |
| `RuntimeUseClient`   | Main client for communicating with the agent runtime |
| `WebSocketTransport` | Default WebSocket-based transport           |
| `AsyncQueue`         | Async queue used by the transport layer     |
| `AgentRuntimeError`  | Thrown when the agent runtime returns an error (carries `.error` and `.metadata`) |
| `CancelledException` | Thrown when `client.abort()` is called during a query |

## Related Docs

- [Repository overview](../../README.md)
- [TypeScript runtime README](../runtimeuse/README.md)
- [Python client README](../runtimeuse-client-python/README.md)
