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

import modal

from runtimeuse_client import (
    RuntimeEnvironmentDownloadableInterface,
    RuntimeUseClient,
    QueryOptions,
    AssistantMessageInterface,
    TextResult,
)

WORKDIR = "/runtimeuse"
_SERVER_READY_SIGNAL = "RuntimeUse server listening on port"


def _get_env_or_fail(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} environment variable is not set")
    return value


def _http_to_ws(url: str) -> str:
    if url.startswith("https://"):
        return "wss://" + url[len("https://"):]
    if url.startswith("http://"):
        return "ws://" + url[len("http://"):]
    return url


def create_sandbox() -> tuple[modal.Sandbox, str]:
    """Create a Modal Sandbox with runtimeuse + Claude Code and return (sandbox, ws_url)."""

    anthropic_api_key = _get_env_or_fail("ANTHROPIC_API_KEY")

    app = modal.App.lookup("runtimeuse-quickstart", create_if_missing=True)

    image = modal.Image.from_registry("node:lts").run_commands(
        "apt-get update && apt-get install -y unzip",
        "npm install -g @anthropic-ai/claude-code",
    )

    secret = modal.Secret.from_dict({"ANTHROPIC_API_KEY": anthropic_api_key})

    print("Creating Modal Sandbox (this may take a few minutes the first time)...")
    with modal.enable_output():
        sandbox = modal.Sandbox.create(
            app=app,
            image=image,
            secrets=[secret],
            workdir=WORKDIR,
            encrypted_ports=[8080],
            timeout=600,
        )
    print(f"Sandbox created: {sandbox.object_id}")

    print("Starting runtimeuse server...")
    process = sandbox.exec(
        "npx", "-y", "runtimeuse", "--agent", "claude",
        env={"ANTHROPIC_API_KEY": anthropic_api_key},
    )

    print("Waiting for runtimeuse server to start...")
    for line in process.stdout:
        print(f"[runtimeuse] {line}", end="")
        if _SERVER_READY_SIGNAL in line:
            break

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
                    working_dir=WORKDIR,
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
