import json
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator, AsyncIterator, Any

import websockets

from .transport import EndSessionMessageHandler

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

    async def end_session(
        self,
        on_message: EndSessionMessageHandler | None = None,
        timeout_s: float = 60.0,
    ) -> None:
        """Send ``end_session_message`` and pump the receive loop until the
        server's ``end_session_confirm_message`` arrives (or timeout).

        The runtime drains its artifact watcher before confirming, so late
        ``artifact_upload_request_message``s may arrive in this window. For
        each incoming message, ``on_message`` is awaited and may return a
        dict response to send back over the socket.
        """
        try:
            await self._ws.send(
                json.dumps({"message_type": "end_session_message"})
            )
        except websockets.exceptions.ConnectionClosed:
            return

        try:
            async with asyncio.timeout(timeout_s):
                async for raw in self._ws:
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if msg.get("message_type") == "end_session_confirm_message":
                        return
                    if on_message is None:
                        continue
                    try:
                        response = await on_message(msg)
                    except Exception:
                        _logger.exception(
                            "Error handling message during end_session drain"
                        )
                        continue
                    if response is None:
                        continue
                    try:
                        await self._ws.send(json.dumps(response))
                    except websockets.exceptions.ConnectionClosed:
                        return
        except (asyncio.TimeoutError, websockets.exceptions.ConnectionClosed):
            return

    async def close(self) -> None:
        """Close the underlying socket without sending end_session_message.

        Callers that need a graceful session end should call
        :meth:`end_session` first.
        """
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
            message_iter = connected.request(send_queue)
            try:
                async for message in message_iter:
                    yield message
            finally:
                await message_iter.aclose()
                _logger.info("Agent runtime connection closed")

    @asynccontextmanager
    async def connect(self) -> AsyncIterator[ConnectedWebSocketTransport]:
        """Open a persistent WebSocket connection for use with a session.

        The connection is closed on exit. Callers that want a graceful session
        end (draining late artifacts) should call
        :meth:`ConnectedWebSocketTransport.end_session` before exiting the
        context.
        """
        _logger.info("Connecting persistent WebSocket to %s", self.ws_url)
        async with websockets.connect(self.ws_url, open_timeout=60) as ws:
            connected = ConnectedWebSocketTransport(ws)
            try:
                yield connected
            finally:
                _logger.info("Persistent agent runtime connection closed")
