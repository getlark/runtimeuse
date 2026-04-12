import asyncio
import logging

import pydantic

from .transports import Transport, WebSocketTransport
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
        """Signal the current query to cancel.

        Sends a cancel message to the agent runtime and causes ``query``
        to raise :class:`CancelledException`.  Safe to call from any
        coroutine on the same event loop.
        """
        self._abort_event.set()

    async def query(
        self,
        prompt: str,
        options: QueryOptions,
    ) -> QueryResult:
        """Send a prompt to the agent runtime and return the result.

        Builds an :class:`InvocationMessage` from *prompt* and *options*,
        sends it over the transport, processes the response stream, and
        returns a :class:`QueryResult`.

        Access ``result.data`` for the :class:`TextResult` or
        :class:`StructuredOutputResult`, and ``result.metadata`` for
        execution metadata.

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

        invocation = InvocationMessage(
            message_type="invocation_message",
            user_prompt=prompt,
            system_prompt=options.system_prompt,
            model=options.model,
            output_format_json_schema_str=options.output_format_json_schema_str,
            source_id=options.source_id,
            secrets_to_redact=options.secrets_to_redact,
            artifacts_dir=options.artifacts_dir,
            pre_agent_invocation_commands=options.pre_agent_invocation_commands,
            post_agent_invocation_commands=options.post_agent_invocation_commands,
            pre_agent_downloadables=options.pre_agent_downloadables,
        )

        send_queue: asyncio.Queue[dict] = asyncio.Queue()
        await send_queue.put(invocation.model_dump(mode="json"))

        wire_result: ResultMessageInterface | None = None

        async with asyncio.timeout(options.timeout):
            async for message in self._transport(send_queue=send_queue):
                if self._abort_event.is_set():
                    logger.info("Query cancelled by caller")
                    await send_queue.put(
                        CancelMessage(message_type="cancel_message").model_dump(
                            mode="json"
                        )
                    )
                    await send_queue.join()
                    raise CancelledException("Query was cancelled")

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
                    wire_result = ResultMessageInterface.model_validate(message)
                    logger.info(
                        f"Received result message from agent runtime: {message}"
                    )
                    continue

                elif message_interface.message_type == "assistant_message":
                    if options.on_assistant_message is not None:
                        assistant_message_interface = (
                            AssistantMessageInterface.model_validate(message)
                        )
                        await options.on_assistant_message(assistant_message_interface)
                    continue

                elif message_interface.message_type == "error_message":
                    try:
                        error_message_interface = ErrorMessageInterface.model_validate(
                            message
                        )
                    except pydantic.ValidationError:
                        logger.error(
                            f"Received malformed error message from agent runtime: {message}",
                        )
                        raise AgentRuntimeError(str(message))
                    logger.error(
                        f"Error from agent runtime: {error_message_interface}",
                    )
                    raise AgentRuntimeError(
                        error_message_interface.error,
                        metadata=error_message_interface.metadata,
                    )

                elif (
                    message_interface.message_type == "artifact_upload_request_message"
                ):
                    logger.info(
                        f"Received artifact upload request message from agent runtime: {message}"
                    )
                    if options.on_artifact_upload_request is not None:
                        artifact_upload_request_message_interface = (
                            ArtifactUploadRequestMessageInterface.model_validate(
                                message
                            )
                        )
                        upload_result = await options.on_artifact_upload_request(
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

        if wire_result is None:
            raise AgentRuntimeError("No result message received")

        return QueryResult(data=wire_result.data, metadata=wire_result.metadata)

    async def execute_commands(
        self,
        commands: list[CommandInterface],
        options: ExecuteCommandsOptions,
    ) -> CommandExecutionResult:
        """Execute commands in the runtime without invoking the agent.

        Sends a :class:`CommandExecutionMessage`, processes the response
        stream, and returns a :class:`CommandExecutionResult` with
        per-command exit codes.

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

        message = CommandExecutionMessage(
            message_type="command_execution_message",
            source_id=options.source_id,
            secrets_to_redact=options.secrets_to_redact,
            commands=commands,
            artifacts_dir=options.artifacts_dir,
            pre_execution_downloadables=options.pre_execution_downloadables,
        )

        send_queue: asyncio.Queue[dict] = asyncio.Queue()
        await send_queue.put(message.model_dump(mode="json"))

        wire_result: CommandExecutionResultMessageInterface | None = None

        async with asyncio.timeout(options.timeout):
            async for msg in self._transport(send_queue=send_queue):
                if self._abort_event.is_set():
                    logger.info("Command execution cancelled by caller")
                    await send_queue.put(
                        CancelMessage(message_type="cancel_message").model_dump(
                            mode="json"
                        )
                    )
                    await send_queue.join()
                    raise CancelledException("Command execution was cancelled")

                try:
                    message_interface = AgentRuntimeMessageInterface.model_validate(
                        msg
                    )
                except pydantic.ValidationError:
                    logger.error(
                        f"Received unknown message type from agent runtime: {msg}"
                    )
                    continue

                if (
                    message_interface.message_type
                    == "command_execution_result_message"
                ):
                    wire_result = (
                        CommandExecutionResultMessageInterface.model_validate(msg)
                    )
                    logger.info(
                        f"Received command execution result from agent runtime: {msg}"
                    )
                    continue

                elif message_interface.message_type == "assistant_message":
                    if options.on_assistant_message is not None:
                        assistant_message_interface = (
                            AssistantMessageInterface.model_validate(msg)
                        )
                        await options.on_assistant_message(
                            assistant_message_interface
                        )
                    continue

                elif message_interface.message_type == "error_message":
                    try:
                        error_message_interface = (
                            ErrorMessageInterface.model_validate(msg)
                        )
                    except pydantic.ValidationError:
                        logger.error(
                            f"Received malformed error message from agent runtime: {msg}",
                        )
                        raise AgentRuntimeError(str(msg))
                    logger.error(
                        f"Error from agent runtime: {error_message_interface}",
                    )
                    raise AgentRuntimeError(
                        error_message_interface.error,
                        metadata=error_message_interface.metadata,
                    )

                elif (
                    message_interface.message_type
                    == "artifact_upload_request_message"
                ):
                    logger.info(
                        f"Received artifact upload request message from agent runtime: {msg}"
                    )
                    if options.on_artifact_upload_request is not None:
                        artifact_upload_request_message_interface = (
                            ArtifactUploadRequestMessageInterface.model_validate(
                                msg
                            )
                        )
                        upload_result = await options.on_artifact_upload_request(
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
                        f"Received non-result message from agent runtime: {msg}"
                    )

        if wire_result is None:
            raise AgentRuntimeError("No result message received")

        return CommandExecutionResult(results=wire_result.results)
