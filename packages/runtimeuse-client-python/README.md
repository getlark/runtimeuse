# runtimeuse (Python)

Python client library for communicating with a [runtimeuse](https://github.com/getlark/runtimeuse) agent runtime over WebSocket.

Handles the WebSocket connection lifecycle, message dispatch, artifact upload handshake, cancellation, and structured result parsing -- so you can focus on what to do with agent results rather than wire protocol details.

## Installation

```bash
pip install runtimeuse
```

## Quick Start

Start the runtime inside any sandbox, then connect from outside:

```python
import asyncio
from runtimeuse import RuntimeUseClient, InvocationMessage, ResultMessageInterface

async def main():
    # Start the runtime in a sandbox (provider-specific)
    sandbox = Sandbox.create()
    sandbox.run("npx -y runtimeuse")
    ws_url = sandbox.get_url(8080)

    # Connect and invoke
    client = RuntimeUseClient(ws_url=ws_url)

    invocation = InvocationMessage(
        message_type="invocation_message",
        source_id="my-run-001",
        system_prompt="You are a helpful assistant.",
        user_prompt="Do the thing and return the result.",
        output_format_json_schema_str='{"type":"json_schema","schema":{"type":"object"}}',
        secrets_to_redact=["sk-secret-key"],
        agent_env={"API_KEY": "sk-secret-key"},
    )

    async def on_result(result: ResultMessageInterface):
        print(f"Success: {result.structured_output.get('success')}")
        print(f"Output: {result.structured_output}")

    await client.invoke(
        invocation=invocation,
        on_result_message=on_result,
        result_message_cls=ResultMessageInterface,
    )

asyncio.run(main())
```

For local development without a sandbox, connect directly:

```python
client = RuntimeUseClient(ws_url="ws://localhost:8080")
```

## Usage

### RuntimeUseClient

Manages the WebSocket connection to the agent runtime and runs the message loop: sends an invocation, iterates the response stream, and dispatches typed messages to your callbacks.

```python
client = RuntimeUseClient(ws_url="ws://localhost:8080")

await client.invoke(
    invocation=invocation,
    on_result_message=on_result,
    result_message_cls=ResultMessageInterface,
    on_assistant_message=on_assistant,       # optional
    on_artifact_upload_request=on_artifact,  # optional -- return (presigned_url, content_type)
    on_error_message=on_error,               # optional
    is_cancelled=check_cancelled,            # optional -- async () -> bool
    timeout=300,                             # optional -- seconds
)
```

### Artifact Upload Handshake

When the agent runtime requests an artifact upload, provide a callback that returns a presigned URL and content type. The client sends the response back automatically.

```python
async def on_artifact(request: ArtifactUploadRequestMessageInterface) -> tuple[str, str]:
    presigned_url = await my_storage.create_presigned_url(request.filename)
    content_type = guess_content_type(request.filename)
    return presigned_url, content_type
```

### Cancellation

Pass an `is_cancelled` callback to cancel a running invocation. When it returns `True`, the client sends a cancel message to the runtime and raises `CancelledException`.

```python
from runtimeuse import CancelledException

async def check_cancelled() -> bool:
    return await db.is_run_cancelled(run_id)

try:
    await client.invoke(
        invocation=invocation,
        on_result_message=on_result,
        result_message_cls=ResultMessageInterface,
        is_cancelled=check_cancelled,
    )
except CancelledException:
    print("Run was cancelled")
```

### Custom Result Types

Subclass `ResultMessageInterface` to add domain-specific fields:

```python
from runtimeuse import ResultMessageInterface

class MyResultMessage(ResultMessageInterface):
    custom_score: float | None = None

await client.invoke(
    invocation=invocation,
    on_result_message=handle_my_result,
    result_message_cls=MyResultMessage,
)
```

## API Reference

### Message Types

| Class                                     | Description                                            |
| ----------------------------------------- | ------------------------------------------------------ |
| `InvocationMessage`                       | Sent to the runtime to start an agent invocation       |
| `ResultMessageInterface`                  | Structured result from the agent                       |
| `AssistantMessageInterface`               | Intermediate assistant text messages                   |
| `ArtifactUploadRequestMessageInterface`   | Runtime requesting a presigned URL for artifact upload |
| `ArtifactUploadResponseMessageInterface`  | Response with presigned URL sent back to runtime       |
| `ErrorMessageInterface`                   | Error from the agent runtime                           |
| `CancelMessage`                           | Sent to cancel a running invocation                    |
| `CommandInterface`                        | Pre/post invocation shell command                      |
| `RuntimeEnvironmentDownloadableInterface` | File to download into the runtime before invocation    |

### Exceptions

| Class                | Description                                 |
| -------------------- | ------------------------------------------- |
| `CancelledException` | Raised when `is_cancelled()` returns `True` |
