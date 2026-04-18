import asyncio
from typing import Any, AsyncGenerator, AsyncContextManager, Awaitable, Callable, Protocol


EndSessionMessageHandler = Callable[[dict[str, Any]], Awaitable[dict[str, Any] | None]]


class Transport(Protocol):
    """Protocol for a one-shot message transport.

    Implementations must be callable async generators that yield parsed messages
    (dicts) from the agent runtime and consume outbound messages from the
    send_queue. The underlying connection is opened on call and closed when the
    generator exits.
    """

    def __call__(
        self, send_queue: asyncio.Queue[dict]
    ) -> AsyncGenerator[dict[str, Any], None]: ...


class ConnectedTransport(Protocol):
    """Protocol for a persistent connection that supports N sequential requests.

    Implementations of this protocol represent an already-open connection.
    Each call to ``request`` runs one request/response cycle over that
    connection until the caller closes the generator (typically after
    receiving a terminal message). The connection stays open between
    requests.
    """

    def request(
        self, send_queue: asyncio.Queue[dict]
    ) -> AsyncGenerator[dict[str, Any], None]: ...

    async def end_session(
        self,
        on_message: EndSessionMessageHandler | None = None,
        timeout_s: float = 60.0,
    ) -> None: ...

    async def close(self) -> None: ...


class PersistentTransport(Protocol):
    """Protocol for a transport that can open a persistent connection.

    ``connect`` returns an async context manager that yields a
    ``ConnectedTransport`` once the connection is open.
    """

    def connect(self) -> AsyncContextManager[ConnectedTransport]: ...
