import asyncio
from typing import Any, AsyncGenerator

import pytest

from src.runtimeuse_client import RuntimeUseClient, InvocationMessage


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


def _make_invocation(**overrides: Any) -> InvocationMessage:
    defaults = dict(
        message_type="invocation_message",
        source_id="test-001",
        system_prompt="You are a good assistant.",
        user_prompt="Do something.",
        output_format_json_schema_str='{"type":"object"}',
        secrets_to_redact=[],
        model="gpt-4o",
    )
    defaults.update(overrides)
    return InvocationMessage.model_validate(defaults)


@pytest.fixture
def fake_transport():
    """Return a factory that creates a (FakeTransport, RuntimeUseClient) pair."""

    def _factory(messages: list[dict] | None = None):
        transport = FakeTransport(messages)
        client = RuntimeUseClient(transport=transport)
        return transport, client

    return _factory


@pytest.fixture
def invocation():
    """Return a default InvocationMessage for tests."""
    return _make_invocation()


@pytest.fixture
def make_invocation():
    """Return the _make_invocation factory for tests that need custom fields."""
    return _make_invocation
