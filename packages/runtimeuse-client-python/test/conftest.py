import asyncio
from typing import Any, AsyncGenerator

import dotenv
import pytest

from src.runtimeuse_client import RuntimeUseClient, QueryOptions, ExecuteCommandsOptions

dotenv.load_dotenv()


class FakeTransport:
    """In-memory transport for testing.

    Yields pre-canned messages and captures everything written to the send queue.
    Drains the send queue synchronously around each yield so tests can assert on
    ``sent`` without waiting for a background drainer.
    """

    def __init__(self, messages: list[dict] | None = None):
        self.messages = messages or []
        self.sent: list[dict] = []

    def _drain(self, send_queue: asyncio.Queue[dict]) -> None:
        while not send_queue.empty():
            item = send_queue.get_nowait()
            self.sent.append(item)
            send_queue.task_done()

    async def __call__(
        self, send_queue: asyncio.Queue[dict]
    ) -> AsyncGenerator[dict[str, Any], None]:
        try:
            for msg in self.messages:
                self._drain(send_queue)
                yield msg
        finally:
            self._drain(send_queue)


class FakePersistentTransport:
    """In-memory transport supporting persistent sessions.

    Each request pulls from a list of pre-canned message batches (one batch per
    request). Captures everything written to the send queue across all requests.
    """

    def __init__(self, request_batches: list[list[dict]] | None = None):
        self.request_batches = list(request_batches or [])
        self.sent: list[dict] = []
        self.closed = False

    def _drain(self, send_queue: asyncio.Queue[dict]) -> None:
        while not send_queue.empty():
            item = send_queue.get_nowait()
            self.sent.append(item)
            send_queue.task_done()

    async def request(
        self, send_queue: asyncio.Queue[dict]
    ) -> AsyncGenerator[dict[str, Any], None]:
        batch = self.request_batches.pop(0) if self.request_batches else []
        try:
            for msg in batch:
                self._drain(send_queue)
                yield msg
        finally:
            self._drain(send_queue)

    async def end_session(self, on_message=None, timeout_s: float = 60.0) -> None:
        return None

    async def close(self) -> None:
        self.closed = True

    def connect(self):
        transport = self

        class _Ctx:
            async def __aenter__(self):
                return transport

            async def __aexit__(self, exc_type, exc, tb):
                await transport.close()

        return _Ctx()


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


def _make_execute_commands_options(**overrides: Any) -> ExecuteCommandsOptions:
    return ExecuteCommandsOptions(**overrides)


@pytest.fixture
def make_execute_commands_options():
    """Return the _make_execute_commands_options factory for tests."""
    return _make_execute_commands_options


@pytest.fixture
def fake_persistent_transport():
    """Return a factory that creates a (FakePersistentTransport, RuntimeUseClient) pair."""

    def _factory(request_batches: list[list[dict]] | None = None):
        transport = FakePersistentTransport(request_batches)
        client = RuntimeUseClient(transport=transport)
        return transport, client

    return _factory
