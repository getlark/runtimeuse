"""Smoke tests: verify that an E2B sandbox can run runtimeuse,
answer a query, and execute commands."""

import pytest

from src.runtimeuse_client import (
    RuntimeUseClient,
    QueryOptions,
    ExecuteCommandsOptions,
    QueryResult,
    CommandExecutionResult,
    CommandInterface,
    TextResult,
    AssistantMessageInterface,
)
from test.sandbox_factories.e2b import create_e2b_runtimeuse

pytestmark = [pytest.mark.sandbox, pytest.mark.asyncio]


class TestE2BSandbox:
    async def test_hello_world(self):
        sandbox, ws_url = create_e2b_runtimeuse(agent="openai")
        try:
            client = RuntimeUseClient(ws_url=ws_url)
            result = await client.query(
                prompt="Say hello world",
                options=QueryOptions(
                    system_prompt="Reply concisely.",
                    model="gpt-5.4",
                ),
            )

            assert isinstance(result, QueryResult)
            assert isinstance(result.data, TextResult)
            assert len(result.data.text) > 0
        finally:
            sandbox.kill()

    async def test_execute_commands(self):
        sandbox, ws_url = create_e2b_runtimeuse(agent="openai")
        try:
            received: list[AssistantMessageInterface] = []

            async def on_msg(msg: AssistantMessageInterface):
                received.append(msg)

            client = RuntimeUseClient(ws_url=ws_url)
            result = await client.execute_commands(
                commands=[
                    CommandInterface(command="echo hello-from-e2b"),
                    CommandInterface(command="node --version"),
                ],
                options=ExecuteCommandsOptions(
                    on_assistant_message=on_msg,
                    timeout=30,
                ),
            )

            assert isinstance(result, CommandExecutionResult)
            assert len(result.results) == 2
            assert result.results[0].exit_code == 0
            assert result.results[0].stdout is not None
            assert "hello-from-e2b" in result.results[0].stdout
            assert result.results[1].exit_code == 0
            assert result.results[1].stdout is not None

            all_text = [block for msg in received for block in msg.text_blocks]
            assert any("hello-from-e2b" in t for t in all_text)
        finally:
            sandbox.kill()

    async def test_execute_commands_failure_returns_exit_code(self):
        sandbox, ws_url = create_e2b_runtimeuse(agent="openai")
        try:
            client = RuntimeUseClient(ws_url=ws_url)
            result = await client.execute_commands(
                commands=[
                    CommandInterface(command="exit 1"),
                ],
                options=ExecuteCommandsOptions(timeout=30),
            )

            assert isinstance(result, CommandExecutionResult)
            assert len(result.results) == 1
            assert result.results[0].exit_code == 1
            assert not result.results[0].stdout
        finally:
            sandbox.kill()

    async def test_execute_commands_failure_skips_remaining(self):
        sandbox, ws_url = create_e2b_runtimeuse(agent="openai")
        try:
            client = RuntimeUseClient(ws_url=ws_url)
            result = await client.execute_commands(
                commands=[
                    CommandInterface(command="echo first"),
                    CommandInterface(command="exit 1"),
                    CommandInterface(command="echo should-not-run"),
                ],
                options=ExecuteCommandsOptions(timeout=30),
            )

            assert isinstance(result, CommandExecutionResult)
            assert len(result.results) == 2
            assert result.results[0].exit_code == 0
            assert result.results[0].stdout is not None
            assert "first" in result.results[0].stdout
            assert result.results[1].exit_code == 1
            assert not result.results[1].stdout
        finally:
            sandbox.kill()
