# runtimeuse

[![Twitter Follow](https://img.shields.io/twitter/follow/getlark)](https://twitter.com/getlark)

Run AI agents inside sandboxes and communicate with them over WebSocket.

| Package                                                    | Language   | Role                                       | Install                         |
| ---------------------------------------------------------- | ---------- | ------------------------------------------ | ------------------------------- |
| [`runtimeuse`](./packages/runtimeuse)                      | TypeScript | Agent runtime (runs inside the sandbox)    | `npm install runtimeuse`        |
| [`runtimeuse-client`](./packages/runtimeuse-client-python) | Python     | Client (connects from outside the sandbox) | `pip install runtimeuse-client` |

## Quick Start

### 1. Start the runtime (inside a sandbox)

```bash
npx -y runtimeuse
```

This starts a WebSocket server on port 8080 using the OpenAI agent handler by default. Use `--agent claude` for Claude. The Claude handler also requires the `claude` CLI to be installed in the sandbox, for example with `npm install -g @anthropic-ai/claude-code`.

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

See the [runtime README](./packages/runtimeuse/README.md) and [client README](./packages/runtimeuse-client-python/README.md) for full API docs.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for local setup, package-specific development commands, and the recommended checks to run before opening a PR.

## License

[FSL-1.1-ALv2](./LICENSE.md)
