# runtimeuse

[![Twitter Follow](https://img.shields.io/twitter/follow/getlark)](https://twitter.com/getlark)

Communicate with AI agents inside sandboxes over WebSocket.

| Package                                                    | Language   | Role                                       | Install                         |
| ---------------------------------------------------------- | ---------- | ------------------------------------------ | ------------------------------- |
| [`runtimeuse`](./packages/runtimeuse)                      | TypeScript | Agent runtime (runs inside the sandbox)    | `npm install runtimeuse`        |
| [`runtimeuse-client`](./packages/runtimeuse-client-python) | Python     | Client (connects from outside the sandbox) | `pip install runtimeuse-client` |

## Quick Start

### 1. Start the runtime (inside a sandbox)

```bash
npx -y runtimeuse@latest
```

This starts a WebSocket server on port 8080 using the OpenAI agent handler by default. Use `--agent claude` for Claude.

### 2. Connect from Python

```python
import asyncio
import json
from runtimeuse_client import RuntimeUseClient, InvocationMessage, ResultMessageInterface

async def main():
    client = RuntimeUseClient(ws_url="ws://localhost:8080")

    invocation = InvocationMessage(
        message_type="invocation_message",
        source_id="my-run-001",
        preferred_model="gpt-4.1",
        system_prompt="You are a helpful assistant.",
        user_prompt="What is 2 + 2?",
        output_format_json_schema_str=json.dumps({
            "type": "json_schema",
            "schema": {
                "type": "object",
                "properties": {"answer": {"type": "string"}},
            },
        }),
        secrets_to_redact=[],
        agent_env={},
    )

    async def on_result(result: ResultMessageInterface):
        print(result.structured_output)

    await client.invoke(
        invocation=invocation,
        on_result_message=on_result,
        result_message_cls=ResultMessageInterface,
    )

asyncio.run(main())
```

### 3. Or use the runtime programmatically (TypeScript)

```typescript
import { RuntimeUseServer, openaiHandler } from "runtimeuse";

const server = new RuntimeUseServer({ handler: openaiHandler, port: 8080 });
await server.start();
```

## How It Works

```
Python Client  ──WebSocket──>  Runtime (in sandbox)  ──>  AgentHandler
                                                           ├── openai (default)
                                                           └── claude
```

1. The client sends an `InvocationMessage` over WebSocket
2. The runtime downloads files and runs pre-commands (if any)
3. The `AgentHandler` executes the agent with the given prompts and model
4. Intermediate `AssistantMessage`s stream back to the client
5. Files in the artifacts directory are auto-detected and uploaded via presigned URL handshake
6. A final `ResultMessage` with structured output is sent back

See the [runtime README](./packages/runtimeuse/README.md) and [client README](./packages/runtimeuse-client-python/README.md) for full API docs.

## License

BSL-1.1
