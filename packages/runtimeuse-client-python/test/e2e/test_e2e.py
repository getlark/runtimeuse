"""End-to-end tests for RuntimeUseClient against a local runtimeuse server
with the deterministic echo handler."""

import json

import pytest

from src.runtimeuse_client import (
    RuntimeUseClient,
    QueryOptions,
    QueryResult,
    TextResult,
    StructuredOutputResult,
    AssistantMessageInterface,
    AgentRuntimeError,
    CancelledException,
)

pytestmark = [pytest.mark.e2e, pytest.mark.asyncio]


class TestTextResult:
    async def test_echo_text(
        self, client: RuntimeUseClient, query_options: QueryOptions
    ):
        result = await client.query(prompt="ECHO:hello world", options=query_options)

        assert isinstance(result, QueryResult)
        assert isinstance(result.data, TextResult)
        assert result.data.text == "hello world"

    async def test_plain_prompt_echoed(
        self, client: RuntimeUseClient, query_options: QueryOptions
    ):
        result = await client.query(prompt="just a plain prompt", options=query_options)

        assert isinstance(result.data, TextResult)
        assert result.data.text == "just a plain prompt"


class TestStructuredOutputResult:
    async def test_structured_output(
        self, client: RuntimeUseClient, make_query_options
    ):
        payload = {"answer": 42, "nested": {"key": "value"}}
        result = await client.query(
            prompt=f"STRUCTURED:{json.dumps(payload)}",
            options=make_query_options(
                output_format_json_schema_str=json.dumps({"type": "object"}),
            ),
        )

        assert isinstance(result.data, StructuredOutputResult)
        assert result.data.structured_output == payload


class TestAssistantStreaming:
    async def test_assistant_messages_streamed(
        self, client: RuntimeUseClient, make_query_options
    ):
        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        result = await client.query(
            prompt="STREAM:3",
            options=make_query_options(on_assistant_message=on_msg),
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == "streamed 3 messages"
        assert len(received) == 3
        assert received[0].text_blocks == ["message 1 of 3"]
        assert received[1].text_blocks == ["message 2 of 3"]
        assert received[2].text_blocks == ["message 3 of 3"]


class TestErrorFromHandler:
    async def test_error_raises(
        self, client: RuntimeUseClient, query_options: QueryOptions
    ):
        with pytest.raises(AgentRuntimeError, match="something broke"):
            await client.query(prompt="ERROR:something broke", options=query_options)


class TestTimeout:
    async def test_timeout_raises(self, client: RuntimeUseClient, make_query_options):
        with pytest.raises(TimeoutError):
            await client.query(
                prompt="SLOW:30000",
                options=make_query_options(timeout=0.5),
            )


class TestCancellation:
    async def test_abort_during_streaming(self, ws_url: str, make_query_options):
        client = RuntimeUseClient(ws_url=ws_url)

        async def abort_on_first(msg: AssistantMessageInterface):
            client.abort()

        with pytest.raises(CancelledException):
            await client.query(
                prompt="STREAM:5",
                options=make_query_options(on_assistant_message=abort_on_first),
            )


class TestInvocationFieldsForwarded:
    async def test_fields_round_trip(
        self, client: RuntimeUseClient, make_query_options
    ):
        result = await client.query(
            prompt="ECHO:field test",
            options=make_query_options(
                system_prompt="Custom system prompt.",
                model="test-model",
                source_id="e2e-source",
            ),
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == "field test"
