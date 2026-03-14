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
from runtimeuse import RuntimeUseClient, QueryOptions

async def main():
    # Start the runtime in a sandbox (provider-specific)
    sandbox = Sandbox.create()
    sandbox.run("npx -y runtimeuse")
    ws_url = sandbox.get_url(8080)

    # Connect and query
    client = RuntimeUseClient(ws_url=ws_url)

    result = await client.query(
        prompt="Do the thing and return the result.",
        options=QueryOptions(
            system_prompt="You are a helpful assistant.",
            model="gpt-4.1",
            output_format_json_schema_str='{"type":"json_schema","schema":{"type":"object"}}',
            source_id="my-run-001",
            secrets_to_redact=["sk-secret-key"],
        ),
    )
    print(f"Success: {result.structured_output.get('success')}")
    print(f"Output: {result.structured_output}")

asyncio.run(main())
```

For local development without a sandbox, connect directly:

```python
client = RuntimeUseClient(ws_url="ws://localhost:8080")
```

## Usage

### RuntimeUseClient

Manages the WebSocket connection to the agent runtime and runs the message loop: sends a prompt, iterates the response stream, and returns the result. Raises `AgentRuntimeError` if the runtime returns an error.

```python
client = RuntimeUseClient(ws_url="ws://localhost:8080")

result = await client.query(
    prompt="Do the thing.",
    options=QueryOptions(
        system_prompt="You are a helpful assistant.",
        model="gpt-4.1",
        output_format_json_schema_str='{"type":"json_schema","schema":{"type":"object"}}',
        on_assistant_message=on_assistant,       # optional
        on_artifact_upload_request=on_artifact,  # optional -- return ArtifactUploadResult
        timeout=300,                             # optional -- seconds
    ),
)
```

### Artifact Upload Handshake

When the agent runtime requests an artifact upload, provide a callback that returns a presigned URL and content type. The client sends the response back automatically.

```python
from runtimeuse import ArtifactUploadResult

async def on_artifact(request: ArtifactUploadRequestMessageInterface) -> ArtifactUploadResult:
    presigned_url = await my_storage.create_presigned_url(request.filename)
    content_type = guess_content_type(request.filename)
    return ArtifactUploadResult(presigned_url=presigned_url, content_type=content_type)
```

### Cancellation

Call `client.abort()` from any coroutine to cancel a running query. The client sends a cancel message to the runtime and `query` raises `CancelledException`.

```python
from runtimeuse import CancelledException

async def cancel_after_delay(client, seconds):
    await asyncio.sleep(seconds)
    client.abort()

try:
    asyncio.create_task(cancel_after_delay(client, 30))
    result = await client.query(
        prompt="Do the thing.",
        options=QueryOptions(
            system_prompt="You are a helpful assistant.",
            model="gpt-4.1",
            output_format_json_schema_str='{"type":"json_schema","schema":{"type":"object"}}',
        ),
    )
except CancelledException:
    print("Run was cancelled")
```

## API Reference

### Types

| Class                                     | Description                                            |
| ----------------------------------------- | ------------------------------------------------------ |
| `QueryOptions`                            | Configuration for `client.query()` (prompt options, callbacks, timeout) |
| `ResultMessageInterface`                  | Structured result from the agent                       |
| `AssistantMessageInterface`               | Intermediate assistant text messages                   |
| `ArtifactUploadRequestMessageInterface`   | Runtime requesting a presigned URL for artifact upload |
| `ArtifactUploadResponseMessageInterface`  | Response with presigned URL sent back to runtime       |
| `ErrorMessageInterface`                   | Error from the agent runtime                           |
| `CommandInterface`                        | Pre/post invocation shell command                      |
| `RuntimeEnvironmentDownloadableInterface` | File to download into the runtime before invocation    |

### Exceptions

| Class                | Description                                 |
| -------------------- | ------------------------------------------- |
| `AgentRuntimeError`  | Raised when the agent runtime returns an error (carries `.error` and `.metadata`) |
| `CancelledException` | Raised when `client.abort()` is called during a query |
