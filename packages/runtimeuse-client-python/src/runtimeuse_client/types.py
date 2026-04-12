import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

from pydantic import BaseModel
from pydantic.fields import Field


class AgentRuntimeMessageInterface(BaseModel):
    message_type: Literal[
        "result_message",
        "assistant_message",
        "artifact_upload_request_message",
        "error_message",
        "command_execution_result_message",
    ]


class RuntimeEnvironmentDownloadableInterface(BaseModel):
    download_url: str
    working_dir: str


class CommandInterface(BaseModel):
    """A command to execute before or after the agent invocation."""

    cwd: str | None = None
    command: str


class InvocationMessage(BaseModel):
    message_type: Literal["invocation_message"]
    source_id: str | None = None
    system_prompt: str
    user_prompt: str
    output_format_json_schema_str: str | None = None
    secrets_to_redact: list[str] = Field(default_factory=list)
    artifacts_dir: str | None = None
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


class CommandExecutionMessage(BaseModel):
    message_type: Literal["command_execution_message"]
    source_id: str | None = None
    secrets_to_redact: list[str] = Field(default_factory=list)
    commands: list[CommandInterface]
    artifacts_dir: str | None = None
    pre_execution_downloadables: list[RuntimeEnvironmentDownloadableInterface] | None = None


class CommandResultItem(BaseModel):
    command: str
    exit_code: int


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
OnArtifactUploadRequestCallback = Callable[
    [ArtifactUploadRequestMessageInterface], Awaitable[ArtifactUploadResult]
]


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
    #: Secret values to redact from agent logs and responses.
    secrets_to_redact: list[str] = field(default_factory=list)
    #: Directory inside the runtime environment where artifacts are written.
    artifacts_dir: str | None = None
    #: Commands to run in the runtime environment before the agent starts.
    pre_agent_invocation_commands: list[CommandInterface] | None = None
    #: Commands to run in the runtime environment after the agent finishes.
    post_agent_invocation_commands: list[CommandInterface] | None = None
    #: Files to download into the runtime environment before invocation.
    pre_agent_downloadables: list[RuntimeEnvironmentDownloadableInterface] | None = None

    #: Called for each assistant (intermediate) message streamed back.
    on_assistant_message: OnAssistantMessageCallback | None = None
    #: Called when the runtime requests an artifact upload URL.
    on_artifact_upload_request: OnArtifactUploadRequestCallback | None = None
    #: Overall timeout in seconds for the query. ``None`` means no limit.
    timeout: float | None = None
    #: Logger instance; falls back to the module-level logger when ``None``.
    logger: logging.Logger | None = None

    def __post_init__(self) -> None:
        has_dir = self.artifacts_dir is not None
        has_cb = self.on_artifact_upload_request is not None
        if has_dir != has_cb:
            raise ValueError(
                "artifacts_dir and on_artifact_upload_request must be specified together"
            )


@dataclass
class ExecuteCommandsOptions:
    """Options for :meth:`RuntimeUseClient.execute_commands`."""

    #: Secret values to redact from command output.
    secrets_to_redact: list[str] = field(default_factory=list)
    #: Caller-defined identifier for tracing/logging purposes.
    source_id: str | None = None
    #: Directory inside the runtime environment where artifacts are written.
    artifacts_dir: str | None = None
    #: Files to download into the runtime environment before commands run.
    pre_execution_downloadables: list[RuntimeEnvironmentDownloadableInterface] | None = None
    #: Called for each assistant (intermediate) message streamed back.
    on_assistant_message: OnAssistantMessageCallback | None = None
    #: Called when the runtime requests an artifact upload URL.
    on_artifact_upload_request: OnArtifactUploadRequestCallback | None = None
    #: Overall timeout in seconds. ``None`` means no limit.
    timeout: float | None = None
    #: Logger instance; falls back to the module-level logger when ``None``.
    logger: logging.Logger | None = None

    def __post_init__(self) -> None:
        has_dir = self.artifacts_dir is not None
        has_cb = self.on_artifact_upload_request is not None
        if has_dir != has_cb:
            raise ValueError(
                "artifacts_dir and on_artifact_upload_request must be specified together"
            )
