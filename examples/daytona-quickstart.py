"""
Daytona Quickstart -- Run Claude Code in a Daytona cloud sandbox using runtimeuse.

Setup:
  pip install runtimeuse-client daytona

Environment variables:
  DAYTONA_API_KEY    - your Daytona API key (https://daytona.io)
  ANTHROPIC_API_KEY  - your Anthropic API key

Usage:
  python daytona-quickstart.py
"""

from __future__ import annotations

import asyncio
import os

from daytona import (
    CreateSandboxFromImageParams,
    Daytona,
    DaytonaConfig,
    Image,
    Sandbox,
    SessionExecuteRequest,
)

from runtimeuse_client import (
    RuntimeEnvironmentDownloadableInterface,
    RuntimeUseClient,
    QueryOptions,
    AssistantMessageInterface,
    TextResult,
)

WORKDIR = "/home/daytona"
_SERVER_READY_SIGNAL = "RuntimeUse server listening on port"
_SERVER_STARTUP_TIMEOUT_S = 120
_SESSION_ID = "runtimeuse"


def _get_env_or_fail(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} environment variable is not set")
    return value


def _http_to_ws(url: str) -> str:
    if url.startswith("https://"):
        return "wss://" + url[len("https://") :]
    if url.startswith("http://"):
        return "ws://" + url[len("http://") :]
    return url


def create_sandbox() -> tuple[Daytona, Sandbox]:
    """Create a Daytona sandbox and return (daytona, sandbox).

    This is intentionally synchronous so that Daytona's internal use of
    ``asyncio.run()`` (for streaming snapshot-build logs) does not conflict
    with an already-running event loop.
    """

    daytona_api_key = _get_env_or_fail("DAYTONA_API_KEY")
    anthropic_api_key = _get_env_or_fail("ANTHROPIC_API_KEY")

    image = Image.base("node:lts").run_commands(
        "apt-get update && apt-get install -y unzip",
        "npm install -g @anthropic-ai/claude-code",
    )

    daytona = Daytona(config=DaytonaConfig(api_key=daytona_api_key))

    print("Creating Daytona sandbox (this may take a few minutes the first time)...")
    sandbox = daytona.create(
        CreateSandboxFromImageParams(
            image=image,
            env_vars={"ANTHROPIC_API_KEY": anthropic_api_key},
            public=True,
        ),
        timeout=300,
        on_snapshot_create_logs=lambda chunk: print(chunk, end=""),
    )
    print(f"Sandbox created: {sandbox.id}")

    return daytona, sandbox


async def _start_server_and_wait(sandbox: Sandbox) -> str:
    """Start the runtimeuse server, stream logs, and wait for the ready signal.

    Returns the WebSocket URL once the server is listening.
    """

    anthropic_api_key = _get_env_or_fail("ANTHROPIC_API_KEY")

    sandbox.process.create_session(_SESSION_ID)
    exec_resp = sandbox.process.execute_session_command(
        _SESSION_ID,
        SessionExecuteRequest(
            command=f"export ANTHROPIC_API_KEY={anthropic_api_key} && npx -y runtimeuse --agent claude",
            run_async=True,
        ),
    )

    ready = asyncio.Event()

    def _on_stdout(log: str) -> None:
        print(f"[runtimeuse] {log}")
        if _SERVER_READY_SIGNAL in log:
            ready.set()

    def _on_stderr(log: str) -> None:
        print(f"[runtimeuse:err] {log}")

    log_task = asyncio.create_task(
        sandbox.process.get_session_command_logs_async(
            _SESSION_ID,
            exec_resp.cmd_id,
            _on_stdout,
            _on_stderr,
        )
    )

    print("Waiting for runtimeuse server to start...")
    try:
        await asyncio.wait_for(ready.wait(), timeout=_SERVER_STARTUP_TIMEOUT_S)
    except asyncio.TimeoutError:
        log_task.cancel()
        raise RuntimeError(
            f"runtimeuse server did not start within {_SERVER_STARTUP_TIMEOUT_S}s"
        )

    preview = sandbox.create_signed_preview_url(8080, expires_in_seconds=3600)
    ws_url = _http_to_ws(preview.url)
    print(f"Sandbox ready at {ws_url}")
    return ws_url


async def _run_query(ws_url: str) -> None:
    client = RuntimeUseClient(ws_url=ws_url)
    print(f"Connected to {ws_url}")

    async def on_message(msg: AssistantMessageInterface) -> None:
        for block in msg.text_blocks:
            print(f"[assistant] {block}")

    prompt = "Summarize the contents of the codex repository and list your favorite file in the repository."
    print(f"Sending query: {prompt}")

    result = await client.query(
        prompt=prompt,
        options=QueryOptions(
            system_prompt="You are a helpful assistant.",
            model="claude-sonnet-4-20250514",
            on_assistant_message=on_message,
            pre_agent_downloadables=[
                RuntimeEnvironmentDownloadableInterface(
                    download_url="https://github.com/openai/codex/archive/refs/heads/main.zip",
                    working_dir=WORKDIR,
                )
            ],
        ),
    )

    print("\n--- Final Result ---")
    assert isinstance(result.data, TextResult)
    print(result.data.text)


def main() -> None:
    daytona, sandbox = create_sandbox()
    try:
        ws_url = asyncio.run(_start_server_and_wait(sandbox))
        asyncio.run(_run_query(ws_url))
    finally:
        daytona.delete(sandbox)
        print("Sandbox deleted.")


if __name__ == "__main__":
    # asyncio.run(_run_query("wss://8080-zgcun375m7vgilui.daytonaproxy01.net"))
    main()
