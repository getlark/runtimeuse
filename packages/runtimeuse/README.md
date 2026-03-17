# runtimeuse (Runtime)

TypeScript runtime package for [runtimeuse](https://github.com/getlark/runtimeuse). Runs inside the sandbox and handles the agent lifecycle: receives invocations over WebSocket, executes your agent handler, manages artifact uploads, runs pre-commands, downloads runtime files, and sends structured results back to the client.

This package is used together with the Python client in [`runtimeuse-client`](../runtimeuse-client-python/README.md), which connects to the runtime from outside the sandbox.

## Installation

```bash
npm install runtimeuse
```

## Quick Start

Run the runtime inside any sandbox:

```bash
npx -y runtimeuse
```

This starts a WebSocket server on port 8080 using the OpenAI agent handler (default). You can choose between built-in handlers:

- **`openai`** (default) -- uses `@openai/agents` SDK
- **`claude`** -- uses `@anthropic-ai/claude-agent-sdk` with Claude Code tools and `bypassPermissions` mode

The Claude handler requires the `claude` CLI to be installed in the sandbox environment.

```bash
npx -y runtimeuse                    # OpenAI (default)
npx -y runtimeuse --agent claude     # Claude
```

Use it programmatically:

```typescript
import { RuntimeUseServer, openaiHandler, claudeHandler } from "runtimeuse";

const server = new RuntimeUseServer({ handler: openaiHandler, port: 8080 });
await server.startListening();
```

### Custom Handler

Implement `AgentHandler` to plug in your own agent:

```typescript
import { RuntimeUseServer } from "runtimeuse";
import type {
  AgentHandler,
  AgentInvocation,
  AgentResult,
  MessageSender,
} from "runtimeuse";

const handler: AgentHandler = {
  async run(
    invocation: AgentInvocation,
    sender: MessageSender,
  ): Promise<AgentResult> {
    sender.sendAssistantMessage(["Running agent..."]);

    const output = await myAgent(
      invocation.systemPrompt,
      invocation.userPrompt,
    );

    return {
      type: "structured_output",
      structuredOutput: output,
      metadata: { duration_ms: 1500 },
    };
  },
};

const server = new RuntimeUseServer({ handler, port: 8080 });
await server.startListening();
```

## Core Concept: AgentHandler

The `AgentHandler` interface is the single integration point. Implement `run()` to plug in any agent.

```typescript
interface AgentHandler {
  run(invocation: AgentInvocation, sender: MessageSender): Promise<AgentResult>;
}
```

**`AgentInvocation`** -- everything your agent needs:

| Field          | Type                                                       | Description                          |
| -------------- | ---------------------------------------------------------- | ------------------------------------ |
| `systemPrompt` | `string`                                                   | System prompt for the agent          |
| `userPrompt`   | `string`                                                   | User prompt / task description       |
| `outputFormat` | `{ type: "json_schema"; schema: Record<string, unknown> }` | Expected output schema               |
| `model`        | `string`                                                   | Model identifier                     |
| `secrets`      | `string[]`                                                 | Values to redact from logs           |
| `signal`       | `AbortSignal`                                              | Observe for cancellation (read-only) |
| `logger`       | `Logger`                                                   | Prefixed logger for this invocation  |

**`MessageSender`** -- send intermediate messages back to the client:

```typescript
sender.sendAssistantMessage(["Step 1: Navigating to login page..."]);
sender.sendErrorMessage("Something went wrong", { code: "TIMEOUT" });
```

**`AgentResult`** -- what your handler returns (discriminated union):

```typescript
type AgentResult =
  | { type: "text"; text: string; metadata?: Record<string, unknown> }
  | { type: "structured_output"; structuredOutput: Record<string, unknown>; metadata?: Record<string, unknown> };
```

## Server Options

### CLI

```bash
npx runtimeuse                            # OpenAI handler (default)
npx runtimeuse --agent claude             # Claude handler
npx runtimeuse --handler ./my-handler.js  # custom handler
npx runtimeuse --port 3000                # custom port
```

### Programmatic

```typescript
import { RuntimeUseServer } from "runtimeuse";

const server = new RuntimeUseServer({
  handler: myHandler,
  port: 8080, // default: 8080
  uploadTimeoutMs: 30_000,
  artifactWaitMs: 60_000,
  postInvocationDelayMs: 3_000,
});

await server.startListening();
// ... later
await server.stop();
```

### Direct Session Usage

For custom WebSocket servers:

```typescript
import { WebSocketSession, UploadTracker } from "runtimeuse";

wss.on("connection", (ws) => {
  const session = new WebSocketSession(ws, {
    handler: myHandler,
    uploadTracker: new UploadTracker(),
  });
  session.run();
});
```

## Invocation Lifecycle

When a client sends an `invocation_message`, the session:

1. **Downloads runtime files** -- if `pre_agent_downloadables` is set, fetches and extracts them
2. **Runs pre-commands** -- if `pre_agent_invocation_commands` is set, executes them. If it exits 0, execution continues to the next command or the agent. Any other non-zero exit code sends an error message and terminates the invocation.
3. **Calls `handler.run()`** -- your agent logic runs with the invocation context and a `MessageSender`
4. **Sends `result_message`** -- the `AgentResult` from your handler is sent back to the client
5. **Finalizes** -- stops artifact watching, waits for pending uploads, closes the WebSocket

## Artifact Management

Files written to the artifacts directory are automatically detected via `chokidar` file watching and uploaded through a presigned URL handshake with the client. The artifacts directory is specified per-invocation via the `artifacts_dir` field in the `InvocationMessage`.

- The client provides the `content_type` for each artifact via the presigned URL response
- `.artifactignore` files are respected (same syntax as `.gitignore`)
- Default ignore patterns exclude `node_modules/`, `dist/`, `__pycache__/`, virtual environments, etc.

## Secret Redaction

The `redactSecrets` utility recursively replaces secret values in strings, arrays, and objects:

```typescript
import { redactSecrets } from "runtimeuse";

const safe = redactSecrets("token=sk-abc123", ["sk-abc123"]);
// "token=[REDACTED]"
```

Command output (stdout/stderr) from pre-commands is automatically redacted using the command's environment variable values.

## API Reference

### Classes

| Class              | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| `RuntimeUseServer` | Standalone WebSocket server that creates sessions per connection |
| `WebSocketSession` | Manages a single WebSocket connection lifecycle                  |
| `ArtifactManager`  | Watches a directory and handles the upload handshake             |
| `UploadTracker`    | Tracks in-flight uploads with timeout support                    |
| `CommandHandler`   | Executes shell commands with secret redaction and abort support  |
| `DownloadHandler`  | Downloads files via `fetch()` with automatic zip extraction      |

### Functions

| Function                             | Description                                        |
| ------------------------------------ | -------------------------------------------------- |
| `uploadFile(path, url, contentType)` | Upload a file to a presigned URL                   |
| `redactSecrets(value, secrets)`      | Recursively redact secrets from any data structure |
| `createLogger(sourceId)`             | Create a prefixed logger                           |
| `sleep(ms)`                          | Promise-based sleep                                |

### Protocol Message Types

| Type                            | Direction         | Description                             |
| ------------------------------- | ----------------- | --------------------------------------- |
| `InvocationMessage`             | Client -> Runtime | Start an agent invocation               |
| `CancelMessage`                 | Client -> Runtime | Cancel a running invocation             |
| `ArtifactUploadResponseMessage` | Client -> Runtime | Presigned URL for artifact upload       |
| `ResultMessage`                 | Runtime -> Client | Structured agent result                 |
| `AssistantMessage`              | Runtime -> Client | Intermediate text from the agent        |
| `ArtifactUploadRequestMessage`  | Runtime -> Client | Request a presigned URL for an artifact |
| `ErrorMessage`                  | Runtime -> Client | Error during execution                  |

## Related Docs

- [Repository overview](../../README.md)
- [Python client README](../runtimeuse-client-python/README.md)
