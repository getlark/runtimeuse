import asyncio
from typing import Any, AsyncGenerator

import dotenv
import pytest

from src.runtimeuse_client import RuntimeUseClient, QueryOptions

dotenv.load_dotenv()


class FakeTransport:
    """In-memory transport for testing.

    Yields pre-canned messages and captures everything written to the send queue.
    """

    def __init__(self, messages: list[dict] | None = None):
        self.messages = messages or []
        self.sent: list[dict] = []

    async def __call__(
        self, send_queue: asyncio.Queue[dict]
    ) -> AsyncGenerator[dict[str, Any], None]:
        async def _drain_forever() -> None:
            while True:
                item = await send_queue.get()
                self.sent.append(item)
                send_queue.task_done()

        drainer = asyncio.create_task(_drain_forever())
        try:
            for msg in self.messages:
                yield msg
            await send_queue.join()
        finally:
            drainer.cancel()
            try:
                await drainer
            except asyncio.CancelledError:
                pass


DEFAULT_PROMPT = "Do something."


def _make_query_options(**overrides: Any) -> QueryOptions:
    defaults = dict(
        system_prompt="You are a good assistant.",
        model="gpt-4o",
    )
    defaults.update(overrides)
    return QueryOptions(**defaults)


@pytest.fixture
def fake_transport():
    """Return a factory that creates a (FakeTransport, RuntimeUseClient) pair."""

    def _factory(messages: list[dict] | None = None):
        transport = FakeTransport(messages)
        client = RuntimeUseClient(transport=transport)
        return transport, client

    return _factory


@pytest.fixture
def query_options():
    """Return default QueryOptions for tests."""
    return _make_query_options()


@pytest.fixture
def make_query_options():
    """Return the _make_query_options factory for tests that need custom fields."""
    return _make_query_options
