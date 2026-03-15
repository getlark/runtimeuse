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
from runtimeuse_client import RuntimeUseClient, QueryOptions

async def main():
    client = RuntimeUseClient(ws_url="ws://localhost:8080")

    result = await client.query(
        prompt="What is 2 + 2?",
        options=QueryOptions(
            system_prompt="You are a helpful assistant.",
            model="gpt-4.1",
        ),
    )

    print(result.data.text)

asyncio.run(main())
```

### 3. Or use the runtime programmatically (TypeScript)

```typescript
import { RuntimeUseServer, openaiHandler } from "runtimeuse";

const server = new RuntimeUseServer({ handler: openaiHandler, port: 8080 });
await server.startListening();
```

## How It Works

```
Python Client  ──> WebSocket  ──>  Runtime (in sandbox)  ──>  AgentHandler
                                                                ├── openai (default)
                                                                └── claude
```

1. The client sends an `InvocationMessage` over WebSocket
2. The runtime downloads files and runs pre-commands (if any)
3. The `AgentHandler` executes the agent with the given prompts and model
4. Intermediate `AssistantMessage`s stream back to the client
5. Files in the artifacts directory are auto-detected and uploaded via presigned URL handshake
6. A final `ResultMessage` with structured output is sent back
7. The runtime runs post-commands (if any)

See the [runtime README](./packages/runtimeuse/README.md) and [client README](./packages/runtimeuse-client-python/README.md) for full API docs.

## License

BSL-1.1
