import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

from pydantic import BaseModel
from pydantic.fields import Field


class AgentRuntimeMessageInterface(BaseModel):
    message_type: Literal[
        "result_message",
        "assistant_message",
        "command_output_message",
        "artifact_upload_request_message",
        "error_message",
        "command_execution_result_message",
        "heartbeat_message",
    ]


class RuntimeEnvironmentDownloadableInterface(BaseModel):
    download_url: str
    working_dir: str


class CommandInterface(BaseModel):
    """A command to execute before or after the agent invocation."""

    cwd: str | None = None
    command: str
    env: dict[str, str] | None = None


class InvocationMessage(BaseModel):
    message_type: Literal["invocation_message"]
    source_id: str | None = None
    system_prompt: str
    user_prompt: str
    agent_env: dict[str, str] | None = None
    output_format_json_schema_str: str | None = None
    secrets_to_redact: list[str] = Field(default_factory=list)
    artifacts_dirs: list[str] | None = None
    pre_agent_invocation_commands: list[CommandInterface] | None = None
    post_agent_invocation_commands: list[CommandInterface] | None = None
    model: str
    pre_agent_downloadables: list[RuntimeEnvironmentDownloadableInterface] | None = None


class TextResult(BaseModel):
    """Result variant returned when no output schema is specified."""

    type: Literal["text"] = "text"
    text: str


class StructuredOutputResult(BaseModel):
    """Result variant returned when an output schema is specified."""

    type: Literal["structured_output"] = "structured_output"
    structured_output: dict[str, Any]


class QueryResult(BaseModel):
    """Result returned by :meth:`RuntimeUseClient.query`."""

    metadata: dict[str, Any] | None = None
    data: TextResult | StructuredOutputResult = Field(discriminator="type")


class ResultMessageInterface(AgentRuntimeMessageInterface):
    """Wire-format result message from the agent runtime."""

    message_type: Literal["result_message"]
    metadata: dict[str, Any] | None = None
    data: TextResult | StructuredOutputResult = Field(discriminator="type")


class AssistantMessageInterface(AgentRuntimeMessageInterface):
    message_type: Literal["assistant_message"]
    text_blocks: list[str]


class CommandOutputMessageInterface(AgentRuntimeMessageInterface):
    """Wire-format message carrying a single chunk of command output.

    Emitted by the runtime for stdout/stderr from commands run via
    ``pre_agent_invocation_commands``, ``post_agent_invocation_commands``,
    or :meth:`RuntimeUseClient.execute_commands`. The ``stream`` field
    distinguishes stdout from stderr, and ``command`` carries the original
    command string for context.
    """

    message_type: Literal["command_output_message"]
    stream: Literal["stdout", "stderr"]
    text: str
    command: str


class HeartbeatMessageInterface(AgentRuntimeMessageInterface):
    message_type: Literal["heartbeat_message"]
    phase: str
    elapsed_ms: int


class ArtifactUploadRequestMessageInterface(AgentRuntimeMessageInterface):
    message_type: Literal["artifact_upload_request_message"]
    filename: str
    filepath: str


class ArtifactUploadResponseMessageInterface(BaseModel):
    message_type: Literal["artifact_upload_response_message"]
    filename: str
    filepath: str
    presigned_url: str
    content_type: str


class ErrorMessageInterface(AgentRuntimeMessageInterface):
    message_type: Literal["error_message"]
    error: str
    metadata: dict[str, Any] | None = None


class CancelMessage(BaseModel):
    message_type: Literal["cancel_message"]


class EndSessionMessage(BaseModel):
    message_type: Literal["end_session_message"]


class EndSessionConfirmMessage(BaseModel):
    message_type: Literal["end_session_confirm_message"]


class CommandExecutionMessage(BaseModel):
    message_type: Literal["command_execution_message"]
    source_id: str | None = None
    secrets_to_redact: list[str] = Field(default_factory=list)
    commands: list[CommandInterface]
    artifacts_dirs: list[str] | None = None
    pre_execution_downloadables: (
        list[RuntimeEnvironmentDownloadableInterface] | None
    ) = None


class CommandResultItem(BaseModel):
    command: str
    exit_code: int
    stdout: str | None = None


class CommandExecutionResult(BaseModel):
    """Result returned by :meth:`RuntimeUseClient.execute_commands`."""

    results: list[CommandResultItem]


class CommandExecutionResultMessageInterface(AgentRuntimeMessageInterface):
    """Wire-format result message from command-only execution."""

    message_type: Literal["command_execution_result_message"]
    results: list[CommandResultItem]


class ArtifactUploadResult(BaseModel):
    presigned_url: str
    content_type: str


OnAssistantMessageCallback = Callable[[AssistantMessageInterface], Awaitable[None]]
OnCommandOutputCallback = Callable[[CommandOutputMessageInterface], Awaitable[None]]
OnArtifactUploadRequestCallback = Callable[
    [ArtifactUploadRequestMessageInterface], Awaitable[ArtifactUploadResult]
]


def _validate_artifact_pairing(
    artifacts_dirs: list[str] | None,
    callback: OnArtifactUploadRequestCallback | None,
) -> None:
    if bool(artifacts_dirs) != (callback is not None):
        raise ValueError(
            "artifacts_dirs and on_artifact_upload_request must be specified together"
        )


@dataclass
class QueryOptions:
    """Options for :meth:`RuntimeUseClient.query`.

    Combines the invocation-level fields (system prompt, model, etc.) with
    runtime behaviour settings (callbacks, timeout).
    """

    #: System prompt prepended to every invocation.
    system_prompt: str
    #: Model identifier passed to the agent runtime (e.g. ``"gpt-4o"``).
    model: str
    #: JSON Schema string describing the desired output structure.
    #: When set, ``result.data`` will be a :class:`StructuredOutputResult`
    #: instead of :class:`TextResult`.
    output_format_json_schema_str: str | None = None

    #: Caller-defined identifier for tracing/logging purposes.
    source_id: str | None = None
    #: Environment variables to set in the agent runtime.
    agent_env: dict[str, str] | None = None
    #: Secret values to redact from agent logs and responses.
    secrets_to_redact: list[str] = field(default_factory=list)
    #: Directories inside the runtime environment where artifacts are written.
    #: Each directory is watched independently and may carry its own
    #: ``.artifactignore``. An empty list is treated the same as ``None``.
    artifacts_dirs: list[str] | None = None
    #: Commands to run in the runtime environment before the agent starts.
    pre_agent_invocation_commands: list[CommandInterface] | None = None
    #: Commands to run in the runtime environment after the agent finishes.
    post_agent_invocation_commands: list[CommandInterface] | None = None
    #: Files to download into the runtime environment before invocation.
    pre_agent_downloadables: list[RuntimeEnvironmentDownloadableInterface] | None = None

    #: Called for each assistant (intermediate) message streamed back.
    on_assistant_message: OnAssistantMessageCallback | None = None
    #: Called for each chunk of stdout/stderr emitted by pre/post commands.
    on_command_output: OnCommandOutputCallback | None = None
    #: Called when the runtime requests an artifact upload URL.
    on_artifact_upload_request: OnArtifactUploadRequestCallback | None = None
    #: Overall timeout in seconds for the query. ``None`` means no limit.
    timeout: float | None = None
    #: Maximum idle time in seconds without any runtime message.
    idle_timeout: float | None = None
    #: Maximum time in seconds allowed for the assistant message callback.
    assistant_callback_timeout: float | None = None
    #: Maximum time in seconds allowed for the artifact upload callback.
    artifact_upload_callback_timeout: float | None = None
    #: Logger instance; falls back to the module-level logger when ``None``.
    logger: logging.Logger | None = None

    def __post_init__(self) -> None:
        _validate_artifact_pairing(
            self.artifacts_dirs, self.on_artifact_upload_request
        )


@dataclass
class ExecuteCommandsOptions:
    """Options for :meth:`RuntimeUseClient.execute_commands`."""

    #: Secret values to redact from command output.
    secrets_to_redact: list[str] = field(default_factory=list)
    #: Caller-defined identifier for tracing/logging purposes.
    source_id: str | None = None
    #: Directories inside the runtime environment where artifacts are written.
    #: Each directory is watched independently and may carry its own
    #: ``.artifactignore``. An empty list is treated the same as ``None``.
    artifacts_dirs: list[str] | None = None
    #: Files to download into the runtime environment before commands run.
    pre_execution_downloadables: (
        list[RuntimeEnvironmentDownloadableInterface] | None
    ) = None
    #: Called for each assistant (intermediate) message streamed back.
    on_assistant_message: OnAssistantMessageCallback | None = None
    #: Called for each chunk of stdout/stderr emitted by the commands.
    on_command_output: OnCommandOutputCallback | None = None
    #: Called when the runtime requests an artifact upload URL.
    on_artifact_upload_request: OnArtifactUploadRequestCallback | None = None
    #: Overall timeout in seconds. ``None`` means no limit.
    timeout: float | None = None
    #: Maximum idle time in seconds without any runtime message.
    idle_timeout: float | None = None
    #: Maximum time in seconds allowed for the assistant message callback.
    assistant_callback_timeout: float | None = None
    #: Maximum time in seconds allowed for the artifact upload callback.
    artifact_upload_callback_timeout: float | None = None
    #: Logger instance; falls back to the module-level logger when ``None``.
    logger: logging.Logger | None = None

    def __post_init__(self) -> None:
        _validate_artifact_pairing(
            self.artifacts_dirs, self.on_artifact_upload_request
        )
