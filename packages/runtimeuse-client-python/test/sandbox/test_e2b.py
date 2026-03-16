"""Smoke test: verify that an E2B sandbox can run runtimeuse and answer a query."""

import pytest

from src.runtimeuse_client import (
    RuntimeUseClient,
    QueryOptions,
    QueryResult,
    TextResult,
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
                    model="gpt-4.1-mini",
                ),
            )

            assert isinstance(result, QueryResult)
            assert isinstance(result.data, TextResult)
            assert len(result.data.text) > 0
        finally:
            sandbox.kill()
