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
export OPENAI_API_KEY=your_openai_api_key
npx -y runtimeuse
```

This starts a WebSocket server on port 8080 using the default OpenAI handler. For fuller Claude-based sandbox examples, see [`examples/`](./examples).

### 2. Connect from Python

```python
import asyncio
from runtimeuse_client import (
    QueryOptions,
    RuntimeEnvironmentDownloadableInterface,
    RuntimeUseClient,
    TextResult,
)

WORKDIR = "/runtimeuse"

async def main():
    client = RuntimeUseClient(ws_url="ws://localhost:8080")

    result = await client.query(
        prompt="Summarize the contents of the codex repository.",
        options=QueryOptions(
            system_prompt="You are a helpful assistant.",
            model="gpt-5.4",
            pre_agent_downloadables=[
                RuntimeEnvironmentDownloadableInterface(
                    download_url="https://github.com/openai/codex/archive/refs/heads/main.zip",
                    working_dir=WORKDIR,
                )
            ],
        ),
    )

    assert isinstance(result.data, TextResult)
    print(result.data.text)

asyncio.run(main())
```

See the [runtime README](./packages/runtimeuse/README.md) and [client README](./packages/runtimeuse-client-python/README.md) for full API docs.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for local setup, package-specific development commands, and the recommended checks to run before opening a PR.

## License

[FSL-1.1-ALv2](./LICENSE.md)
