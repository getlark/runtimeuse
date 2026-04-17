import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import pydantic

from .transports import ConnectedTransport, Transport, WebSocketTransport
from .types import (
    InvocationMessage,
    CommandExecutionMessage,
    AgentRuntimeMessageInterface,
    CancelMessage,
    ErrorMessageInterface,
    ResultMessageInterface,
    CommandExecutionResultMessageInterface,
    QueryResult,
    CommandExecutionResult,
    CommandInterface,
    AssistantMessageInterface,
    ArtifactUploadRequestMessageInterface,
    ArtifactUploadResponseMessageInterface,
    QueryOptions,
    ExecuteCommandsOptions,
)
from .exceptions import AgentRuntimeError, CancelledException

_default_logger = logging.getLogger(__name__)


def _build_invocation(prompt: str, options: QueryOptions) -> InvocationMessage:
    return InvocationMessage(
        message_type="invocation_message",
        user_prompt=prompt,
        system_prompt=options.system_prompt,
        model=options.model,
        output_format_json_schema_str=options.output_format_json_schema_str,
        source_id=options.source_id,
        agent_env=options.agent_env,
        secrets_to_redact=options.secrets_to_redact,
        artifacts_dir=options.artifacts_dir,
        pre_agent_invocation_commands=options.pre_agent_invocation_commands,
        post_agent_invocation_commands=options.post_agent_invocation_commands,
        pre_agent_downloadables=options.pre_agent_downloadables,
    )


def _build_command_execution(
    commands: list[CommandInterface], options: ExecuteCommandsOptions
) -> CommandExecutionMessage:
    return CommandExecutionMessage(
        message_type="command_execution_message",
        source_id=options.source_id,
        secrets_to_redact=options.secrets_to_redact,
        commands=commands,
        artifacts_dir=options.artifacts_dir,
        pre_execution_downloadables=options.pre_execution_downloadables,
    )


async def _handle_artifact_request(
    message: dict,
    on_artifact_upload_request,
    send_queue: asyncio.Queue[dict],
    logger: logging.Logger,
) -> None:
    logger.info(
        f"Received artifact upload request message from agent runtime: {message}"
    )
    if on_artifact_upload_request is None:
        return
    req = ArtifactUploadRequestMessageInterface.model_validate(message)
    upload_result = await on_artifact_upload_request(req)
    response = ArtifactUploadResponseMessageInterface(
        message_type="artifact_upload_response_message",
        filename=req.filename,
        filepath=req.filepath,
        presigned_url=upload_result.presigned_url,
        content_type=upload_result.content_type,
    )
    await send_queue.put(response.model_dump(mode="json"))


async def _run_request_loop(
    message_iter,
    send_queue: asyncio.Queue[dict],
    abort_event: asyncio.Event,
    *,
    terminal_message_type: str,
    result_cls,
    on_assistant_message,
    on_artifact_upload_request,
    cancelled_message: str,
    logger: logging.Logger,
):
    """Drive the message loop for a single request and return the terminal result.

    Iterates ``message_iter`` until it sees a terminal (result or error) message
    or ``abort_event`` is set. Raises ``AgentRuntimeError`` on error messages,
    ``CancelledException`` on abort.
    """
    wire_result = None
    async for message in message_iter:
        if abort_event.is_set():
            raise CancelledException(cancelled_message)

        try:
            message_interface = AgentRuntimeMessageInterface.model_validate(message)
        except pydantic.ValidationError:
            logger.error(
                f"Received unknown message type from agent runtime: {message}"
            )
            continue

        if message_interface.message_type == terminal_message_type:
            wire_result = result_cls.model_validate(message)
            logger.info(
                f"Received terminal message from agent runtime: {message}"
            )
            break

        if message_interface.message_type == "assistant_message":
            if on_assistant_message is not None:
                assistant = AssistantMessageInterface.model_validate(message)
                await on_assistant_message(assistant)
            continue

        if message_interface.message_type == "error_message":
            try:
                err = ErrorMessageInterface.model_validate(message)
            except pydantic.ValidationError:
                logger.error(
                    f"Received malformed error message from agent runtime: {message}"
                )
                raise AgentRuntimeError(str(message))
            logger.error(f"Error from agent runtime: {err}")
            raise AgentRuntimeError(err.error, metadata=err.metadata)

        if message_interface.message_type == "artifact_upload_request_message":
            await _handle_artifact_request(
                message, on_artifact_upload_request, send_queue, logger
            )
            continue

        logger.info(
            f"Received non-result message from agent runtime: {message}"
        )

    if abort_event.is_set():
        raise CancelledException(cancelled_message)

    if wire_result is None:
        raise AgentRuntimeError("No result message received")

    return wire_result


class RuntimeUseSession:
    """A persistent session over a single transport connection.

    Exposes :meth:`query` and :meth:`execute_commands` with the same
    signatures as :class:`RuntimeUseClient` but dispatches each call as a
    separate request/response cycle over the already-open transport.
    """

    def __init__(self, connected: ConnectedTransport):
        self._connected = connected
        self._abort_event = asyncio.Event()
        self._send_queue: asyncio.Queue[dict] | None = None
        self._lock = asyncio.Lock()

    def abort(self) -> None:
        """Signal the in-flight request to cancel.

        Sends a ``cancel_message`` to the runtime (which aborts the current
        request without closing the session) and causes the in-flight call to
        raise :class:`CancelledException`.
        """
        self._abort_event.set()
        send_queue = self._send_queue
        if send_queue is not None:
            send_queue.put_nowait(
                CancelMessage(message_type="cancel_message").model_dump(mode="json")
            )

    async def query(self, prompt: str, options: QueryOptions) -> QueryResult:
        async with self._lock:
            logger = options.logger or _default_logger
            self._abort_event = asyncio.Event()

            invocation = _build_invocation(prompt, options)
            send_queue: asyncio.Queue[dict] = asyncio.Queue()
            self._send_queue = send_queue
            await send_queue.put(invocation.model_dump(mode="json"))

            try:
                async with asyncio.timeout(options.timeout):
                    message_iter = self._connected.request(send_queue)
                    try:
                        wire = await _run_request_loop(
                            message_iter,
                            send_queue,
                            self._abort_event,
                            terminal_message_type="result_message",
                            result_cls=ResultMessageInterface,
                            on_assistant_message=options.on_assistant_message,
                            on_artifact_upload_request=options.on_artifact_upload_request,
                            cancelled_message="Query was cancelled",
                            logger=logger,
                        )
                    finally:
                        await message_iter.aclose()
            finally:
                self._send_queue = None

            return QueryResult(data=wire.data, metadata=wire.metadata)

    async def execute_commands(
        self,
        commands: list[CommandInterface],
        options: ExecuteCommandsOptions,
    ) -> CommandExecutionResult:
        async with self._lock:
            logger = options.logger or _default_logger
            self._abort_event = asyncio.Event()

            message = _build_command_execution(commands, options)
            send_queue: asyncio.Queue[dict] = asyncio.Queue()
            self._send_queue = send_queue
            await send_queue.put(message.model_dump(mode="json"))

            try:
                async with asyncio.timeout(options.timeout):
                    message_iter = self._connected.request(send_queue)
                    try:
                        wire = await _run_request_loop(
                            message_iter,
                            send_queue,
                            self._abort_event,
                            terminal_message_type="command_execution_result_message",
                            result_cls=CommandExecutionResultMessageInterface,
                            on_assistant_message=options.on_assistant_message,
                            on_artifact_upload_request=options.on_artifact_upload_request,
                            cancelled_message="Command execution was cancelled",
                            logger=logger,
                        )
                    finally:
                        await message_iter.aclose()
            finally:
                self._send_queue = None

            return CommandExecutionResult(results=wire.results)


class RuntimeUseClient:
    """Client for communicating with a runtimeuse agent runtime.

    Handles message dispatch, artifact upload handshake, cancellation, and
    structured result parsing.

    Args:
        ws_url: WebSocket URL for the agent runtime. Used to create the default
            WebSocketTransport. Ignored when a custom transport is provided.
        transport: Optional custom transport implementing the Transport protocol.
            When provided, ws_url is not required.

    Both one-shot (:meth:`query`, :meth:`execute_commands`) and persistent
    (:meth:`session`) styles are supported. One-shot calls open a connection,
    run a single request, and close. :meth:`session` opens a connection that
    can service multiple sequential calls.
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
        self._send_queue: asyncio.Queue[dict] | None = None

    def abort(self) -> None:
        """Signal the current one-shot call to cancel.

        Sends a ``cancel_message`` to the agent runtime and causes the active
        :meth:`query` or :meth:`execute_commands` call to raise
        :class:`CancelledException`. Safe to call from any coroutine on the
        same event loop.

        For persistent sessions, use :meth:`RuntimeUseSession.abort` instead.
        """
        self._abort_event.set()
        send_queue = self._send_queue
        if send_queue is not None:
            send_queue.put_nowait(
                CancelMessage(message_type="cancel_message").model_dump(mode="json")
            )

    @asynccontextmanager
    async def session(self) -> AsyncIterator[RuntimeUseSession]:
        """Open a persistent session to the agent runtime.

        Yields a :class:`RuntimeUseSession` that can service multiple
        sequential :meth:`RuntimeUseSession.query` /
        :meth:`RuntimeUseSession.execute_commands` calls over a single
        connection. The connection is closed (and ``end_session_message`` is
        sent to the runtime) when the context exits.

        Requires a transport that supports persistent connections (the
        default :class:`WebSocketTransport` does).
        """
        connect = getattr(self._transport, "connect", None)
        if connect is None:
            raise TypeError(
                "The configured transport does not support persistent sessions. "
                "Use a transport that implements PersistentTransport (e.g. WebSocketTransport)."
            )
        async with connect() as connected:
            yield RuntimeUseSession(connected)

    async def query(
        self,
        prompt: str,
        options: QueryOptions,
    ) -> QueryResult:
        """Send a prompt to the agent runtime and return the result.

        Convenience one-shot wrapper: opens a connection, sends one
        invocation, and closes. For multiple sequential calls over a single
        connection, use :meth:`session`.

        Args:
            prompt: The user prompt to send to the agent.
            options: Query configuration including system prompt, model,
                output schema, callbacks, and timeout.

        Raises:
            AgentRuntimeError: If the runtime sends an error or no result is produced.
            CancelledException: If the query is cancelled via :meth:`abort`.
            TimeoutError: If the timeout is exceeded.
        """
        logger = options.logger or _default_logger

        self._abort_event = asyncio.Event()

        invocation = _build_invocation(prompt, options)

        send_queue: asyncio.Queue[dict] = asyncio.Queue()
        self._send_queue = send_queue
        await send_queue.put(invocation.model_dump(mode="json"))

        try:
            async with asyncio.timeout(options.timeout):
                wire = await _run_request_loop(
                    self._transport(send_queue=send_queue),
                    send_queue,
                    self._abort_event,
                    terminal_message_type="result_message",
                    result_cls=ResultMessageInterface,
                    on_assistant_message=options.on_assistant_message,
                    on_artifact_upload_request=options.on_artifact_upload_request,
                    cancelled_message="Query was cancelled",
                    logger=logger,
                )
        finally:
            self._send_queue = None

        return QueryResult(data=wire.data, metadata=wire.metadata)

    async def execute_commands(
        self,
        commands: list[CommandInterface],
        options: ExecuteCommandsOptions,
    ) -> CommandExecutionResult:
        """Execute commands in the runtime without invoking the agent.

        Convenience one-shot wrapper: opens a connection, sends one command
        execution request, and closes. For multiple sequential calls over a
        single connection, use :meth:`session`.

        Args:
            commands: Commands to execute in the runtime environment.
            options: Execution configuration including secrets, callbacks,
                artifacts, and timeout.

        Raises:
            AgentRuntimeError: If a command fails or the runtime sends an error.
            CancelledException: If cancelled via :meth:`abort`.
            TimeoutError: If the timeout is exceeded.
        """
        logger = options.logger or _default_logger

        self._abort_event = asyncio.Event()

        message = _build_command_execution(commands, options)
        send_queue: asyncio.Queue[dict] = asyncio.Queue()
        self._send_queue = send_queue
        await send_queue.put(message.model_dump(mode="json"))

        try:
            async with asyncio.timeout(options.timeout):
                wire = await _run_request_loop(
                    self._transport(send_queue=send_queue),
                    send_queue,
                    self._abort_event,
                    terminal_message_type="command_execution_result_message",
                    result_cls=CommandExecutionResultMessageInterface,
                    on_assistant_message=options.on_assistant_message,
                    on_artifact_upload_request=options.on_artifact_upload_request,
                    cancelled_message="Command execution was cancelled",
                    logger=logger,
                )
        finally:
            self._send_queue = None

        return CommandExecutionResult(results=wire.results)
