import asyncio
from typing import AsyncGenerator, Any, Protocol


class Transport(Protocol):
    """Protocol for the underlying message transport.

    Implementations must be callable async generators that yield parsed messages
    (dicts) from the agent runtime and consume outbound messages from the
    send_queue.
    """

    def __call__(
        self, send_queue: asyncio.Queue[dict]
    ) -> AsyncGenerator[dict[str, Any], None]: ...
