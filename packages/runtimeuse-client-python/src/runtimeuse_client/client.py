import asyncio
import logging
from typing import Callable, Awaitable, Type, TypeVar

import pydantic

from .transports import Transport, WebSocketTransport
from .types import (
    InvocationMessage,
    AgentRuntimeMessageInterface,
    CancelMessage,
    ErrorMessageInterface,
    ResultMessageInterface,
    AssistantMessageInterface,
    ArtifactUploadRequestMessageInterface,
    ArtifactUploadResponseMessageInterface,
    OnAssistantMessageCallback,
    OnArtifactUploadRequestCallback,
    OnErrorMessageCallback,
)
from .exceptions import CancelledException

_default_logger = logging.getLogger(__name__)

T = TypeVar("T", bound=ResultMessageInterface)


class RuntimeUseClient:
    """Client for communicating with a runtimeuse agent runtime.

    Handles message dispatch, artifact upload handshake, cancellation, and
    structured result parsing.

    Args:
        ws_url: WebSocket URL for the agent runtime. Used to create the default
            WebSocketTransport. Ignored when a custom transport is provided.
        transport: Optional custom transport implementing the Transport protocol.
            When provided, ws_url is not required.
    """

    def __init__(
        self,
        ws_url: str | None = None,
        transport: Transport | None = None,
    ):
        if transport is not None:
            self._transport = transport
        elif ws_url is not None:
            self._transport = WebSocketTransport(ws_url)
        else:
            raise ValueError("Either ws_url or transport must be provided")

        self._abort_event = asyncio.Event()

    def abort(self) -> None:
        """Signal the current invocation to cancel.

        Sends a cancel message to the agent runtime and causes ``invoke``
        to raise :class:`CancelledException`.  Safe to call from any
        coroutine on the same event loop.
        """
        self._abort_event.set()

    async def invoke(
        self,
        invocation: InvocationMessage,
        # this should be response instead?
        on_result_message: Callable[[T], Awaitable[None]],
        result_message_cls: Type[T],
        on_assistant_message: OnAssistantMessageCallback | None = None,
        on_artifact_upload_request: OnArtifactUploadRequestCallback | None = None,
        on_error_message: OnErrorMessageCallback | None = None,
        timeout: float | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        """Invoke the agent runtime and process the message stream.

        Args:
            invocation: The invocation message to send to the agent runtime.
            on_result_message: Async callback invoked when a result_message is received.
            result_message_cls: The Pydantic model class to use when validating result
                messages.
            on_assistant_message: Optional async callback invoked when an assistant_message
                is received.
            on_artifact_upload_request: Optional async callback invoked when an
                artifact_upload_request_message is received. Should return an
                ArtifactUploadResult; the client will send the
                artifact_upload_response_message back to the agent runtime automatically.
            on_error_message: Optional async callback invoked when an error_message is
                received.
            timeout: Optional timeout in seconds. Raises asyncio.TimeoutError if exceeded.
            logger: Optional logger instance. Falls back to module-level logger.
        """
        if logger is None:
            logger = _default_logger

        self._abort_event = asyncio.Event()

        send_queue: asyncio.Queue[dict] = asyncio.Queue()
        await send_queue.put(invocation.model_dump(mode="json"))

        async with asyncio.timeout(timeout):
            async for message in self._transport(send_queue=send_queue):
                if self._abort_event.is_set():
                    logger.info("Invocation cancelled by caller")
                    await send_queue.put(
                        CancelMessage(message_type="cancel_message").model_dump(
                            mode="json"
                        )
                    )
                    await send_queue.join()
                    raise CancelledException("Invocation was cancelled")

                try:
                    message_interface = AgentRuntimeMessageInterface.model_validate(
                        message
                    )
                except pydantic.ValidationError:
                    logger.error(
                        f"Received unknown message type from agent runtime: {message}"
                    )
                    continue

                if message_interface.message_type == "result_message":
                    result_message_interface = result_message_cls.model_validate(
                        message
                    )
                    logger.info(
                        f"Received result message from agent runtime: {message}"
                    )
                    await on_result_message(result_message_interface)
                    continue

                elif message_interface.message_type == "assistant_message":
                    if on_assistant_message is not None:
                        assistant_message_interface = (
                            AssistantMessageInterface.model_validate(message)
                        )
                        await on_assistant_message(assistant_message_interface)
                    continue

                elif message_interface.message_type == "error_message":
                    if on_error_message is not None:
                        try:
                            error_message_interface = (
                                ErrorMessageInterface.model_validate(message)
                            )
                            logger.error(
                                f"Error from agent runtime: {error_message_interface}",
                            )
                            await on_error_message(error_message_interface)
                        except pydantic.ValidationError:
                            logger.error(
                                f"Received unknown error message from agent runtime: {message}",
                            )
                            continue
                    continue

                elif (
                    message_interface.message_type == "artifact_upload_request_message"
                ):
                    logger.info(
                        f"Received artifact upload request message from agent runtime: {message}"
                    )
                    if on_artifact_upload_request is not None:
                        artifact_upload_request_message_interface = (
                            ArtifactUploadRequestMessageInterface.model_validate(
                                message
                            )
                        )
                        upload_result = await on_artifact_upload_request(
                            artifact_upload_request_message_interface
                        )
                        artifact_upload_response_message_interface = ArtifactUploadResponseMessageInterface(
                            message_type="artifact_upload_response_message",
                            filename=artifact_upload_request_message_interface.filename,
                            filepath=artifact_upload_request_message_interface.filepath,
                            presigned_url=upload_result.presigned_url,
                            content_type=upload_result.content_type,
                        )
                        await send_queue.put(
                            artifact_upload_response_message_interface.model_dump(
                                mode="json"
                            )
                        )
                    continue

                else:
                    logger.info(
                        f"Received non-result message from agent runtime: {message}"
                    )
