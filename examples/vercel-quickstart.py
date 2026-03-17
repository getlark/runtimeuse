"""
Vercel Quickstart -- Run Claude Code in a Vercel Sandbox using runtimeuse.

Setup:
  pip install runtimeuse-client vercel python-dotenv
  npm i -g vercel          # needed for auth setup
  vercel link              # link to a Vercel project
  vercel env pull           # creates .env.local with OIDC token

  Alternatively, set VERCEL_TOKEN to a Vercel access token.

Environment variables:
  VERCEL_TOKEN       - your Vercel access token
  VERCEL_PROJECT_ID  - your Vercel project ID
  VERCEL_TEAM_ID     - your Vercel team ID
  ANTHROPIC_API_KEY  - your Anthropic API key

Usage:
  python vercel-quickstart.py
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel

load_dotenv()
load_dotenv(Path.cwd() / ".env.local")

from vercel.sandbox import Sandbox

from runtimeuse_client import (
    RuntimeEnvironmentDownloadableInterface,
    RuntimeUseClient,
    QueryOptions,
    AssistantMessageInterface,
    StructuredOutputResult,
)

WORKDIR = "/vercel/sandbox"
_SERVER_READY_SIGNAL = "RuntimeUse server listening on port"


class RepoStats(BaseModel):
    file_count: int
    char_count: int


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


def create_sandbox() -> tuple[Sandbox, str]:
    """Create a Vercel Sandbox, install deps, start runtimeuse, and return (sandbox, ws_url)."""

    anthropic_api_key = _get_env_or_fail("ANTHROPIC_API_KEY")

    print("Creating Vercel Sandbox...")
    sandbox = Sandbox.create(
        runtime="node24",
        ports=[8081],
        env={
            "ANTHROPIC_API_KEY": anthropic_api_key,
            "IS_SANDBOX": "1",
            "CLAUDE_SKIP_ROOT_CHECK": "1",
        },
    )
    print(f"Sandbox created: {sandbox.sandbox_id}")

    print("Installing dependencies...")
    sandbox.run_command("sudo", ["dnf", "install", "-y", "unzip"])
    sandbox.run_command("npm", ["install", "-g", "@anthropic-ai/claude-code"])

    print("Starting runtimeuse server...")
    cmd = sandbox.run_command_detached(
        "npx",
        ["-y", "runtimeuse", "--agent", "claude", "--port", "8081"],
    )

    print("Waiting for runtimeuse server to start...")
    for log in cmd.logs():
        if log.stream == "stdout":
            print(f"[runtimeuse] {log.data}", end="")
        else:
            print(f"[runtimeuse:err] {log.data}", end="")
        if _SERVER_READY_SIGNAL in log.data:
            break

    domain = sandbox.domain(8081)
    ws_url = _http_to_ws(domain)
    print(f"Sandbox ready at {ws_url}")

    return sandbox, ws_url


async def _run_query(ws_url: str) -> None:
    client = RuntimeUseClient(ws_url=ws_url)
    print(f"Connected to {ws_url}")

    async def on_message(msg: AssistantMessageInterface) -> None:
        for block in msg.text_blocks:
            print(f"[assistant] {block}")

    prompt = "Inspect the codex repository and return the total file count and total character count across all files as JSON."
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
            output_format_json_schema_str=json.dumps(
                {
                    "type": "json_schema",
                    "schema": RepoStats.model_json_schema(),
                }
            ),
        ),
    )

    print("\n--- Final Result ---")
    assert isinstance(result.data, StructuredOutputResult)
    stats = RepoStats.model_validate(result.data.structured_output)
    print(stats.model_dump())


def main() -> None:
    sandbox, ws_url = create_sandbox()
    try:
        asyncio.run(_run_query(ws_url))
    finally:
        sandbox.stop()
        print("Sandbox stopped.")


if __name__ == "__main__":
    main()
