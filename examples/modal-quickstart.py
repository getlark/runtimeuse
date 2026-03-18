"""
Modal Quickstart -- Run Claude Code in a Modal sandbox using runtimeuse.

Setup:
  pip install runtimeuse-client modal

  Authenticate with Modal by running `modal token set` or by setting
  MODAL_TOKEN_ID and MODAL_TOKEN_SECRET environment variables.

Environment variables:
  ANTHROPIC_API_KEY  - your Anthropic API key

Usage:
  python modal-quickstart.py
"""

from __future__ import annotations

import asyncio
import os
import queue
import threading
import time

import modal
from modal.exception import ClientClosed

from runtimeuse_client import (
    RuntimeEnvironmentDownloadableInterface,
    RuntimeUseClient,
    QueryOptions,
    AssistantMessageInterface,
    TextResult,
)

_SERVER_READY_SIGNAL = "RuntimeUse server listening on port"
_SERVER_STARTUP_TIMEOUT_S = 120


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


def _wait_for_server_ready(process) -> None:
    log_queue: queue.Queue[tuple[str, str]] = queue.Queue()
    ready = threading.Event()

    def _pump_stream(prefix: str, stream) -> None:
        try:
            for line in stream:
                log_queue.put((prefix, line))
                if _SERVER_READY_SIGNAL in line:
                    ready.set()
        except ClientClosed:
            # The example tears down the sandbox after the query finishes, which can
            # close the underlying Modal client while daemon threads are still
            # draining logs.
            return

    for prefix, stream in (
        ("[runtimeuse]", process.stdout),
        ("[runtimeuse:err]", process.stderr),
    ):
        threading.Thread(
            target=_pump_stream,
            args=(prefix, stream),
            daemon=True,
        ).start()

    deadline = time.monotonic() + _SERVER_STARTUP_TIMEOUT_S
    while time.monotonic() < deadline:
        while True:
            try:
                prefix, line = log_queue.get_nowait()
            except queue.Empty:
                break
            print(f"{prefix} {line}", end="")

        if ready.is_set():
            return

        exit_code = process.poll()
        if exit_code is not None:
            raise RuntimeError(
                f"runtimeuse server exited before becoming ready (exit code {exit_code})"
            )

        time.sleep(0.2)

    raise RuntimeError(
        f"runtimeuse server did not start within {_SERVER_STARTUP_TIMEOUT_S}s"
    )


def create_sandbox() -> tuple[modal.Sandbox, str]:
    """Create a Modal Sandbox with runtimeuse + Claude Code and return (sandbox, ws_url)."""

    anthropic_api_key = _get_env_or_fail("ANTHROPIC_API_KEY")

    app = modal.App.lookup("runtimeuse-quickstart", create_if_missing=True)

    image = modal.Image.from_registry("node:lts").run_commands(
        "apt-get update && apt-get install -y unzip",
        "npm install -g @anthropic-ai/claude-code",
    )

    secret = modal.Secret.from_dict(
        {
            "ANTHROPIC_API_KEY": anthropic_api_key,
            "IS_SANDBOX": "1",
            "CLAUDE_SKIP_ROOT_CHECK": "1",
        }
    )

    print("Creating Modal Sandbox (this may take a few minutes the first time)...")
    with modal.enable_output():
        sandbox = modal.Sandbox.create(
            app=app,
            image=image,
            secrets=[secret],
            encrypted_ports=[8080],
            timeout=600,
        )
    print(f"Sandbox created: {sandbox.object_id}")

    print("Starting runtimeuse server...")

    process = sandbox.exec(
        "npx",
        "-y",
        "runtimeuse",
        "--agent",
        "claude",
    )

    print("Waiting for runtimeuse server to start...")
    _wait_for_server_ready(process)

    tunnel = sandbox.tunnels()[8080]
    ws_url = _http_to_ws(tunnel.url)
    print(f"Sandbox ready at {ws_url}")

    return sandbox, ws_url


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
                    working_dir=".",
                )
            ],
        ),
    )

    print("\n--- Final Result ---")
    assert isinstance(result.data, TextResult)
    print(result.data.text)


def main() -> None:
    sandbox, ws_url = create_sandbox()
    try:
        asyncio.run(_run_query(ws_url))
    finally:
        sandbox.terminate()
        sandbox.detach()
        print("Sandbox terminated.")


if __name__ == "__main__":
    main()
