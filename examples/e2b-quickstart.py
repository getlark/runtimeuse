"""
E2B Quickstart -- Run Claude Code in an E2B cloud sandbox using runtimeuse.

Setup:
  pip install runtimeuse-client e2b e2b-code-interpreter

Environment variables:
  E2B_API_KEY        - your E2B API key (https://e2b.dev)
  ANTHROPIC_API_KEY  - your Anthropic API key

Usage:
  python e2b-quickstart.py
"""

from __future__ import annotations

import asyncio
import os

from e2b import Template, wait_for_port, default_build_logger
from e2b_code_interpreter import Sandbox

from runtimeuse_client import (
    RuntimeUseClient,
    QueryOptions,
    AssistantMessageInterface,
    TextResult,
)


def _get_env_or_fail(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} environment variable is not set")
    return value


def create_sandbox() -> tuple[Sandbox, str]:
    """Build an E2B template with runtimeuse + Claude Code and return (sandbox, ws_url)."""
    e2b_api_key = _get_env_or_fail("E2B_API_KEY")
    anthropic_api_key = _get_env_or_fail("ANTHROPIC_API_KEY")

    alias = "runtimeuse-quickstart-claude"
    start_cmd = "npx -y runtimeuse --agent claude"

    print(
        f"Building E2B template '{alias}' (this may take a few minutes the first time)..."
    )

    template = (
        Template()
        .from_node_image("lts")
        .apt_install(["unzip"])
        .npm_install(["@anthropic-ai/claude-code"], g=True)
        .set_envs({"ANTHROPIC_API_KEY": anthropic_api_key})
        .set_start_cmd(start_cmd, wait_for_port(8080))
    )

    Template.build(
        template,
        alias,
        cpu_count=2,
        memory_mb=2048,
        on_build_logs=default_build_logger(),
    )

    sandbox = Sandbox.create(template=alias, api_key=e2b_api_key)
    ws_url = f"wss://{sandbox.get_host(8080)}"
    print(f"Sandbox ready at {ws_url}")

    return sandbox, ws_url


async def main() -> None:
    sandbox, ws_url = create_sandbox()
    try:
        client = RuntimeUseClient(ws_url=ws_url)
        print(f"Connected to {ws_url}")

        async def on_message(msg: AssistantMessageInterface) -> None:
            for block in msg.text_blocks:
                print(f"[assistant] {block}")

        prompt = "What files are in the current directory? List them."
        print(f"Sending query: {prompt}")

        result = await client.query(
            prompt=prompt,
            options=QueryOptions(
                system_prompt="You are a helpful assistant.",
                model="claude-sonnet-4-20250514",
                on_assistant_message=on_message,
            ),
        )

        print("\n--- Final Result ---")
        assert isinstance(result.data, TextResult)
        print(result.data.text)
    finally:
        sandbox.kill()
        print("Sandbox terminated.")


if __name__ == "__main__":
    asyncio.run(main())
