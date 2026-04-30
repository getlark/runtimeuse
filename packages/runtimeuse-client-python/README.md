# runtimeuse (Python)

Python client library for communicating with a [runtimeuse](https://github.com/getlark/runtimeuse) agent runtime over WebSocket.

Handles the WebSocket connection lifecycle, message dispatch, artifact upload handshake, cancellation, and structured result parsing -- so you can focus on what to do with agent results rather than wire protocol details.

## Installation

```bash
pip install runtimeuse-client
```

## Quick Start

Start the runtime inside any sandbox, then connect from outside:

```python
import asyncio
from runtimeuse_client import (
    AssistantMessageInterface,
    QueryOptions,
    RuntimeEnvironmentDownloadableInterface,
    RuntimeUseClient,
    StructuredOutputResult,
    TextResult,
)

WORKDIR = "/runtimeuse"

async def main():
    # Start the runtime in a sandbox (provider-specific)
    sandbox = Sandbox.create()
    sandbox.run("npx -y runtimeuse@latest")
    ws_url = sandbox.get_url(8080)

    client = RuntimeUseClient(ws_url=ws_url)

    async def on_assistant(msg: AssistantMessageInterface) -> None:
        for block in msg.text_blocks:
            print(f"[assistant] {block}")

    # Text response (no output schema)
    result = await client.query(
        prompt="Summarize the contents of the codex repository and list your favorite file in the repository.",
        options=QueryOptions(
            system_prompt="You are a helpful assistant.",
            model="gpt-4.1",
            on_assistant_message=on_assistant,
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

    # Structured response (with output schema)
    result = await client.query(
        prompt="Inspect the codex repository and return the total file count and total character count across all files as JSON.",
        options=QueryOptions(
            system_prompt="You are a helpful assistant.",
            model="gpt-4.1",
            pre_agent_downloadables=[
                RuntimeEnvironmentDownloadableInterface(
                    download_url="https://github.com/openai/codex/archive/refs/heads/main.zip",
                    working_dir=WORKDIR,
                )
            ],
            output_format_json_schema_str="""
{
  "type": "json_schema",
  "schema": {
    "type": "object",
    "properties": {
      "file_count": { "type": "integer" },
      "char_count": { "type": "integer" }
    },
    "required": ["file_count", "char_count"],
    "additionalProperties": false
  }
}
""",
        ),
    )
    assert isinstance(result.data, StructuredOutputResult)
    print(result.data.structured_output)
    print(result.metadata)  # execution metadata

asyncio.run(main())
```

For local development without a sandbox, connect directly:

```python
client = RuntimeUseClient(ws_url="ws://localhost:8080")
```

## Usage

### RuntimeUseClient

Manages the WebSocket connection to the agent runtime and runs the message loop: sends a prompt, iterates the response stream, and returns a `QueryResult`. Raises `AgentRuntimeError` if the runtime returns an error.

`query()` returns a `QueryResult` with `.data` (a `TextResult` or `StructuredOutputResult`) and `.metadata`.

```python
client = RuntimeUseClient(ws_url="ws://localhost:8080")

result = await client.query(
    prompt="Summarize the contents of the codex repository.",
    options=QueryOptions(
        system_prompt="You are a helpful assistant.",
        model="gpt-4.1",
        agent_env={"MY_VAR": "value"},               # optional -- env vars for the agent
        pre_agent_downloadables=[downloadable],          # optional
        output_format_json_schema_str='...',         # optional -- omit for text response
        on_assistant_message=on_assistant,            # optional -- agent text blocks
        on_command_output=on_command_output,          # optional -- pre/post command stdout/stderr
        on_artifact_upload_request=on_artifact,       # optional -- return ArtifactUploadResult
        timeout=300,                                  # optional -- seconds
    ),
)

if isinstance(result.data, TextResult):
    print(result.data.text)
elif isinstance(result.data, StructuredOutputResult):
    print(result.data.structured_output)

print(result.metadata)  # execution metadata
```

### Command-Only Execution

Use `execute_commands()` when you need to run shell commands in the sandbox without invoking the agent. This is useful for setup steps, health checks, or any workflow where you only need command exit codes.

```python
from runtimeuse_client import (
    CommandInterface,
    ExecuteCommandsOptions,
    RuntimeUseClient,
)

client = RuntimeUseClient(ws_url="ws://localhost:8080")

result = await client.execute_commands(
    commands=[
        CommandInterface(command="mkdir -p /app/output"),
        CommandInterface(command="echo 'sandbox is ready' > /app/output/status.txt"),
        CommandInterface(command="cat /app/output/status.txt", env={"MY_VAR": "value"}),
    ],
    options=ExecuteCommandsOptions(
        on_command_output=on_command_output,  # optional -- streams stdout/stderr
    ),
)

for item in result.results:
    print(f"{item.command} -> exit code {item.exit_code}")
```

`execute_commands()` supports the same streaming, cancellation, timeout, secret redaction, artifact upload, and error semantics as `query()`. If any command exits non-zero, `AgentRuntimeError` is raised.

### Artifact Upload Handshake

When the agent runtime requests an artifact upload, provide a callback that returns a presigned URL and content type. The client sends the response back automatically.

```python
from runtimeuse_client import ArtifactUploadResult

async def on_artifact(request: ArtifactUploadRequestMessageInterface) -> ArtifactUploadResult:
    presigned_url = await my_storage.create_presigned_url(request.filename)
    content_type = guess_content_type(request.filename)
    return ArtifactUploadResult(presigned_url=presigned_url, content_type=content_type)
```

When using artifact uploads, set both `artifacts_dirs` (a list of sandbox directories to watch) and `on_artifact_upload_request` in `QueryOptions`; the client validates that they are provided together. Pass multiple paths to watch several directories within a single invocation.

### Cancellation

Call `client.abort()` from any coroutine to cancel a running query. The client sends a cancel message to the runtime and `query` raises `CancelledException`.

```python
from runtimeuse_client import CancelledException

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
        ),
    )
except CancelledException:
    print("Run was cancelled")
```

## API Reference

### Types

| Class                                     | Description                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `QueryOptions`                            | Configuration for `client.query()` (prompt options, `agent_env`, callbacks, timeout) |
| `QueryResult`                             | Return type of `query()` (`.data`, `.metadata`)                                      |
| `ResultMessageInterface`                  | Wire-format result message from the runtime                                          |
| `TextResult`                              | Result variant when no output schema is specified (`.text`)                          |
| `StructuredOutputResult`                  | Result variant when an output schema is specified (`.structured_output`)             |
| `AssistantMessageInterface`               | Intermediate assistant text messages                                                 |
| `ArtifactUploadRequestMessageInterface`   | Runtime requesting a presigned URL for artifact upload                               |
| `ArtifactUploadResponseMessageInterface`  | Response with presigned URL sent back to runtime                                     |
| `ErrorMessageInterface`                   | Error from the agent runtime                                                         |
| `ExecuteCommandsOptions`                  | Configuration for `client.execute_commands()` (callbacks, timeout)                   |
| `CommandExecutionResult`                  | Return type of `execute_commands()` (`.results`)                                     |
| `CommandResultItem`                       | Per-command result (`.command`, `.exit_code`)                                        |
| `CommandInterface`                        | Shell command to execute (`.command`, `.cwd`, `.env`)                                |
| `RuntimeEnvironmentDownloadableInterface` | File to download into the runtime before invocation                                  |

### Exceptions

| Class                | Description                                                                       |
| -------------------- | --------------------------------------------------------------------------------- |
| `AgentRuntimeError`  | Raised when the agent runtime returns an error (carries `.error` and `.metadata`) |
| `CancelledException` | Raised when `client.abort()` is called during a query                             |

## Related Docs

- [Repository overview](../../README.md)
- [TypeScript runtime README](../runtimeuse/README.md)
