from typing import Any, Literal

from pydantic import BaseModel
from pydantic.fields import Field


class AgentRuntimeMessageInterface(BaseModel):
    message_type: Literal[
        "result_message",
        "assistant_message",
        "artifact_upload_request_message",
        "error_message",
    ]


class RuntimeEnvironmentDownloadableInterface(BaseModel):
    download_url: str
    working_dir: str


class CommandInterface(BaseModel):
    """A command to execute before or after the agent invocation."""

    cwd: str | None = None
    command: str
    env: dict[str, str] = Field(default_factory=dict)


class InvocationMessage(BaseModel):
    message_type: Literal["invocation_message"]
    source_id: str
    system_prompt: str
    user_prompt: str
    output_format_json_schema_str: str
    secrets_to_redact: list[str]
    agent_env: dict[str, str]
    artifacts_dir: str | None = None
    pre_agent_invocation_commands: list[CommandInterface] | None = None
    post_agent_invocation_commands: list[CommandInterface] | None = None
    preferred_model: str
    runtime_environment_downloadables: (
        list[RuntimeEnvironmentDownloadableInterface] | None
    ) = None


class ResultMessageInterface(AgentRuntimeMessageInterface):
    message_type: Literal["result_message"]
    metadata: dict[str, Any] | None = None
    structured_output: dict[str, Any]


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
