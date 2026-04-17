import json
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator, AsyncIterator, Any

import websockets

_logger = logging.getLogger(__name__)


class ConnectedWebSocketTransport:
    """An already-open WebSocket connection supporting N sequential requests."""

    def __init__(self, ws: "websockets.ClientConnection"):
        self._ws = ws

    async def request(
        self, send_queue: asyncio.Queue[dict]
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Run one request/response cycle over the open socket.

        Yields incoming messages from the server and drains ``send_queue`` over
        the socket concurrently. The caller is expected to close the generator
        (e.g. by breaking out of ``async for``) once a terminal message has
        been consumed; the socket stays open for subsequent requests.
        """
        sender_task = asyncio.create_task(self._queue_sender(send_queue))
        try:
            async for message in self._ws:
                try:
                    yield json.loads(message)
                except json.JSONDecodeError:
                    yield {"raw": message}
        except websockets.exceptions.ConnectionClosed:
            return
        finally:
            sender_task.cancel()
            try:
                await sender_task
            except asyncio.CancelledError:
                pass

    async def close(self, send_end_message: bool = True) -> None:
        """Close the connection, optionally sending end_session_message first."""
        if send_end_message:
            try:
                await self._ws.send(
                    json.dumps({"message_type": "end_session_message"})
                )
            except websockets.exceptions.ConnectionClosed:
                pass
        await self._ws.close()

    async def _queue_sender(self, send_queue: asyncio.Queue[dict]) -> None:
        while True:
            message = await send_queue.get()
            try:
                await self._ws.send(json.dumps(message))
            finally:
                send_queue.task_done()


class WebSocketTransport:
    """Transport that communicates over a WebSocket connection.

    Supports both one-shot use via ``__call__`` (for :meth:`RuntimeUseClient.query`
    and :meth:`RuntimeUseClient.execute_commands`) and persistent sessions via
    :meth:`connect` (for :meth:`RuntimeUseClient.session`).
    """

    def __init__(self, ws_url: str):
        self.ws_url = ws_url

    async def __call__(
        self, send_queue: asyncio.Queue[dict]
    ) -> AsyncGenerator[dict[str, Any], None]:
        _logger.info("Connecting to WebSocket at %s", self.ws_url)

        async with websockets.connect(self.ws_url, open_timeout=60) as ws:
            connected = ConnectedWebSocketTransport(ws)
            try:
                async for message in connected.request(send_queue):
                    yield message
            finally:
                _logger.info("Agent runtime connection closed")

    @asynccontextmanager
    async def connect(self) -> AsyncIterator[ConnectedWebSocketTransport]:
        """Open a persistent WebSocket connection for use with a session.

        Sends ``end_session_message`` and closes the socket on exit.
        """
        _logger.info("Connecting persistent WebSocket to %s", self.ws_url)
        async with websockets.connect(self.ws_url, open_timeout=60) as ws:
            connected = ConnectedWebSocketTransport(ws)
            try:
                yield connected
            finally:
                await connected.close(send_end_message=True)
                _logger.info("Persistent agent runtime connection closed")
