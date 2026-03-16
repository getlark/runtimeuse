import json
import asyncio
import logging
from typing import AsyncGenerator, Any

import websockets

_logger = logging.getLogger(__name__)


class WebSocketTransport:
    """Transport that communicates over a WebSocket connection."""

    def __init__(self, ws_url: str):
        self.ws_url = ws_url

    async def __call__(
        self, send_queue: asyncio.Queue[dict]
    ) -> AsyncGenerator[dict[str, Any], None]:
        _logger.info("Connecting to WebSocket at %s", self.ws_url)

        async with websockets.connect(self.ws_url, open_timeout=60) as ws:
            sender_task = asyncio.create_task(self._queue_sender(ws, send_queue))
            try:
                async for message in ws:
                    try:
                        data = json.loads(message)
                        yield data
                    except json.JSONDecodeError:
                        yield {"raw": message}
            except websockets.exceptions.ConnectionClosed as e:
                e.add_note(f"Send queue is empty: {send_queue.empty()}")
            finally:
                sender_task.cancel()
                try:
                    await sender_task
                except asyncio.CancelledError:
                    pass
                _logger.info("Agent runtime connection closed")

    async def _queue_sender(
        self, ws: websockets.ClientConnection, send_queue: asyncio.Queue[dict]
    ) -> None:
        while True:
            message = await send_queue.get()
            try:
                await ws.send(json.dumps(message))
            finally:
                send_queue.task_done()
