"""LLM integration tests using the OpenAI agent."""

import json

import pytest

from src.runtimeuse_client import (
    AgentRuntimeError,
    RuntimeUseClient,
    QueryOptions,
    QueryResult,
    TextResult,
    StructuredOutputResult,
)

pytestmark = [pytest.mark.llm, pytest.mark.asyncio]

MODEL = "gpt-4.1-mini"

STRUCTURED_SCHEMA = json.dumps(
    {
        "type": "json_schema",
        "schema": {
            "type": "object",
            "properties": {
                "greeting": {"type": "string"},
            },
            "required": ["greeting"],
            "additionalProperties": False,
        },
    }
)


class TestOpenAIText:
    async def test_text_response(self, openai_ws_url: str):
        client = RuntimeUseClient(ws_url=openai_ws_url)
        result = await client.query(
            prompt="Say hello world",
            options=QueryOptions(
                system_prompt="Reply concisely in plain text.",
                model=MODEL,
            ),
        )

        assert isinstance(result, QueryResult)
        assert isinstance(result.data, TextResult)
        assert len(result.data.text) > 0


class TestOpenAIStructuredOutput:
    async def test_structured_response(self, openai_ws_url: str):
        client = RuntimeUseClient(ws_url=openai_ws_url)
        result = await client.query(
            prompt="Greet the user",
            options=QueryOptions(
                system_prompt="Reply with a greeting.",
                model=MODEL,
                output_format_json_schema_str=STRUCTURED_SCHEMA,
            ),
        )

        assert isinstance(result, QueryResult)
        assert isinstance(result.data, StructuredOutputResult)
        assert "greeting" in result.data.structured_output
        assert isinstance(result.data.structured_output["greeting"], str)
        assert len(result.data.structured_output["greeting"]) > 0


class TestOpenAIError:
    async def test_invalid_model_raises_error(self, openai_ws_url: str):
        client = RuntimeUseClient(ws_url=openai_ws_url)
        with pytest.raises(AgentRuntimeError):
            await client.query(
                prompt="Say hello",
                options=QueryOptions(
                    system_prompt="Reply concisely.",
                    model="nonexistent-model-xyz",
                ),
            )
