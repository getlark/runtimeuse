"""End-to-end tests for RuntimeUseClient against a local runtimeuse server
with the deterministic echo handler."""

import json
import os
from uuid import uuid4

import pytest

from src.runtimeuse_client import (
    RuntimeUseClient,
    QueryOptions,
    ExecuteCommandsOptions,
    QueryResult,
    CommandExecutionResult,
    CommandResultItem,
    TextResult,
    StructuredOutputResult,
    AssistantMessageInterface,
    ArtifactUploadRequestMessageInterface,
    ArtifactUploadResult,
    AgentRuntimeError,
    CancelledException,
    CommandInterface,
    RuntimeEnvironmentDownloadableInterface,
)

pytestmark = [pytest.mark.e2e, pytest.mark.asyncio]


class TestTextResult:
    async def test_echo_text(
        self, client: RuntimeUseClient, query_options: QueryOptions
    ):
        result = await client.query(prompt="ECHO:hello world", options=query_options)

        assert isinstance(result, QueryResult)
        assert isinstance(result.data, TextResult)
        assert result.data.text == "hello world"

    async def test_plain_prompt_echoed(
        self, client: RuntimeUseClient, query_options: QueryOptions
    ):
        result = await client.query(prompt="just a plain prompt", options=query_options)

        assert isinstance(result.data, TextResult)
        assert result.data.text == "just a plain prompt"


class TestStructuredOutputResult:
    async def test_structured_output(
        self, client: RuntimeUseClient, make_query_options
    ):
        payload = {"answer": 42, "nested": {"key": "value"}}
        result = await client.query(
            prompt=f"STRUCTURED:{json.dumps(payload)}",
            options=make_query_options(
                output_format_json_schema_str=json.dumps({"type": "object"}),
            ),
        )

        assert isinstance(result.data, StructuredOutputResult)
        assert result.data.structured_output == payload


class TestAssistantStreaming:
    async def test_assistant_messages_streamed(
        self, client: RuntimeUseClient, make_query_options
    ):
        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        result = await client.query(
            prompt="STREAM:3",
            options=make_query_options(on_assistant_message=on_msg),
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == "streamed 3 messages"
        assert len(received) == 3
        assert received[0].text_blocks == ["message 1 of 3"]
        assert received[1].text_blocks == ["message 2 of 3"]
        assert received[2].text_blocks == ["message 3 of 3"]


class TestErrorFromHandler:
    async def test_error_raises(
        self, client: RuntimeUseClient, query_options: QueryOptions
    ):
        with pytest.raises(AgentRuntimeError, match="something broke"):
            await client.query(prompt="ERROR:something broke", options=query_options)


class TestTimeout:
    async def test_timeout_raises(self, client: RuntimeUseClient, make_query_options):
        with pytest.raises(TimeoutError):
            await client.query(
                prompt="SLOW:30000",
                options=make_query_options(timeout=0.5),
            )


class TestCancellation:
    async def test_abort_during_streaming(self, ws_url: str, make_query_options):
        client = RuntimeUseClient(ws_url=ws_url)

        async def abort_on_first(msg: AssistantMessageInterface):
            client.abort()

        with pytest.raises(CancelledException):
            await client.query(
                prompt="STREAM:5",
                options=make_query_options(on_assistant_message=abort_on_first),
            )


class TestPrePostCommands:
    async def test_pre_command_output_streamed(
        self, client: RuntimeUseClient, make_query_options
    ):
        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        result = await client.query(
            prompt="ECHO:hello",
            options=make_query_options(
                pre_agent_invocation_commands=[
                    CommandInterface(command="echo pre-sentinel")
                ],
                on_assistant_message=on_msg,
            ),
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == "hello"
        all_text = [block for msg in received for block in msg.text_blocks]
        assert any("pre-sentinel" in t for t in all_text)

    async def test_post_command_output_streamed(
        self, client: RuntimeUseClient, make_query_options
    ):
        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        result = await client.query(
            prompt="ECHO:hello",
            options=make_query_options(
                post_agent_invocation_commands=[
                    CommandInterface(command="echo post-sentinel")
                ],
                on_assistant_message=on_msg,
            ),
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == "hello"
        all_text = [block for msg in received for block in msg.text_blocks]
        assert any("post-sentinel" in t for t in all_text)

    async def test_pre_and_post_commands_both_run(
        self, client: RuntimeUseClient, make_query_options
    ):
        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        result = await client.query(
            prompt="ECHO:hello",
            options=make_query_options(
                pre_agent_invocation_commands=[
                    CommandInterface(command="echo pre-sentinel")
                ],
                post_agent_invocation_commands=[
                    CommandInterface(command="echo post-sentinel")
                ],
                on_assistant_message=on_msg,
            ),
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == "hello"
        all_text = [block for msg in received for block in msg.text_blocks]
        assert any("pre-sentinel" in t for t in all_text)
        assert any("post-sentinel" in t for t in all_text)

    async def test_pre_command_with_cwd(
        self, client: RuntimeUseClient, make_query_options
    ):
        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        await client.query(
            prompt="ECHO:ok",
            options=make_query_options(
                pre_agent_invocation_commands=[
                    CommandInterface(command="pwd", cwd="/tmp")
                ],
                on_assistant_message=on_msg,
            ),
        )

        all_text = [block for msg in received for block in msg.text_blocks]
        assert any("/tmp" in t for t in all_text)

    async def test_post_command_with_cwd(
        self, client: RuntimeUseClient, make_query_options
    ):
        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        await client.query(
            prompt="ECHO:ok",
            options=make_query_options(
                post_agent_invocation_commands=[
                    CommandInterface(command="pwd", cwd="/tmp")
                ],
                on_assistant_message=on_msg,
            ),
        )

        all_text = [block for msg in received for block in msg.text_blocks]
        assert any("/tmp" in t for t in all_text)

    async def test_failed_pre_command_raises_error(
        self, client: RuntimeUseClient, make_query_options
    ):
        with pytest.raises(AgentRuntimeError, match="failed with exit code"):
            await client.query(
                prompt="ECHO:should not reach",
                options=make_query_options(
                    pre_agent_invocation_commands=[
                        CommandInterface(command="exit 1")
                    ],
                ),
            )

    async def test_failed_post_command_raises_error(
        self, client: RuntimeUseClient, make_query_options
    ):
        with pytest.raises(AgentRuntimeError, match="failed with exit code"):
            await client.query(
                prompt="ECHO:hello",
                options=make_query_options(
                    post_agent_invocation_commands=[
                        CommandInterface(command="exit 1")
                    ],
                ),
            )


class TestArtifacts:
    async def test_artifact_upload_request_received(
        self, client: RuntimeUseClient, make_query_options
    ):
        artifacts_dir = f"/tmp/test-artifacts-{uuid4()}"
        os.makedirs(artifacts_dir, exist_ok=True)
        received_requests: list[ArtifactUploadRequestMessageInterface] = []

        async def on_artifact(
            req: ArtifactUploadRequestMessageInterface,
        ) -> ArtifactUploadResult:
            received_requests.append(req)
            return ArtifactUploadResult(
                presigned_url="http://localhost:1/fake-upload",
                content_type="text/plain",
            )

        result = await client.query(
            prompt=f"WRITE_FILE:{artifacts_dir}/test.txt test-content",
            options=make_query_options(
                artifacts_dir=artifacts_dir,
                on_artifact_upload_request=on_artifact,
                timeout=15,
            ),
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == f"wrote {artifacts_dir}/test.txt"
        assert len(received_requests) == 1
        assert received_requests[0].filename == "test.txt"


class TestInvocationFieldsForwarded:
    async def test_fields_round_trip(
        self, client: RuntimeUseClient, make_query_options
    ):
        result = await client.query(
            prompt="ECHO:field test",
            options=make_query_options(
                system_prompt="Custom system prompt.",
                model="test-model",
                source_id="e2e-source",
            ),
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == "field test"


class TestArtifactUploadIntegration:
    """Verify that artifact file content actually reaches the upload target."""

    async def test_artifact_content_uploaded(
        self, client: RuntimeUseClient, make_query_options, http_server
    ):
        base_url, _files, uploads = http_server
        artifacts_dir = f"/tmp/test-artifacts-{uuid4()}"
        os.makedirs(artifacts_dir, exist_ok=True)

        async def on_artifact(
            req: ArtifactUploadRequestMessageInterface,
        ) -> ArtifactUploadResult:
            return ArtifactUploadResult(
                presigned_url=f"{base_url}/uploads/{req.filename}",
                content_type="text/plain",
            )

        result = await client.query(
            prompt=f"WRITE_FILE:{artifacts_dir}/hello.txt some-content",
            options=make_query_options(
                artifacts_dir=artifacts_dir,
                on_artifact_upload_request=on_artifact,
                timeout=15,
            ),
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == f"wrote {artifacts_dir}/hello.txt"
        assert uploads.get("hello.txt") == b"some-content"

    async def test_multiple_artifacts_uploaded(
        self, ws_url: str, make_query_options, http_server
    ):
        base_url, _files, uploads = http_server
        artifacts_dir = f"/tmp/test-artifacts-{uuid4()}"
        os.makedirs(artifacts_dir, exist_ok=True)

        async def on_artifact(
            req: ArtifactUploadRequestMessageInterface,
        ) -> ArtifactUploadResult:
            return ArtifactUploadResult(
                presigned_url=f"{base_url}/uploads/{req.filename}",
                content_type="text/plain",
            )

        opts = dict(
            artifacts_dir=artifacts_dir,
            on_artifact_upload_request=on_artifact,
            timeout=15,
        )

        client1 = RuntimeUseClient(ws_url=ws_url)
        result1 = await client1.query(
            prompt=f"WRITE_FILE:{artifacts_dir}/one.txt first",
            options=make_query_options(**opts),
        )
        assert isinstance(result1.data, TextResult)

        client2 = RuntimeUseClient(ws_url=ws_url)
        result2 = await client2.query(
            prompt=f"WRITE_FILE:{artifacts_dir}/two.txt second",
            options=make_query_options(**opts),
        )
        assert isinstance(result2.data, TextResult)

        assert uploads.get("one.txt") == b"first"
        assert uploads.get("two.txt") == b"second"


class TestPreAgentDownloadables:
    """Verify pre_agent_downloadables are fetched into the runtime before the agent runs."""

    async def test_downloaded_file_accessible(
        self, client: RuntimeUseClient, make_query_options, http_server
    ):
        base_url, files, _uploads = http_server
        files["setup.sh"] = b"#!/bin/bash\necho hello"
        working_dir = f"/tmp/dl-test-{uuid4()}"

        result = await client.query(
            prompt=f"READ_FILE:{working_dir}/setup.sh",
            options=make_query_options(
                pre_agent_downloadables=[
                    RuntimeEnvironmentDownloadableInterface(
                        download_url=f"{base_url}/files/setup.sh",
                        working_dir=working_dir,
                    )
                ],
            ),
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == "#!/bin/bash\necho hello"

    async def test_multiple_downloadables(
        self, ws_url: str, make_query_options, http_server
    ):
        base_url, files, _uploads = http_server
        files["a.txt"] = b"content-a"
        files["b.txt"] = b"content-b"
        working_dir = f"/tmp/dl-test-{uuid4()}"

        client = RuntimeUseClient(ws_url=ws_url)
        result = await client.query(
            prompt=f"READ_FILE:{working_dir}/a.txt",
            options=make_query_options(
                pre_agent_downloadables=[
                    RuntimeEnvironmentDownloadableInterface(
                        download_url=f"{base_url}/files/a.txt",
                        working_dir=working_dir,
                    ),
                    RuntimeEnvironmentDownloadableInterface(
                        download_url=f"{base_url}/files/b.txt",
                        working_dir=working_dir,
                    ),
                ],
            ),
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == "content-a"

        client2 = RuntimeUseClient(ws_url=ws_url)
        result2 = await client2.query(
            prompt=f"READ_FILE:{working_dir}/b.txt",
            options=make_query_options(
                pre_agent_downloadables=[],
            ),
        )
        assert isinstance(result2.data, TextResult)
        assert result2.data.text == "content-b"

    async def test_download_failure_raises_error(
        self, client: RuntimeUseClient, make_query_options, http_server
    ):
        base_url, _files, _uploads = http_server
        working_dir = f"/tmp/dl-test-{uuid4()}"

        with pytest.raises(AgentRuntimeError, match="Download failed"):
            await client.query(
                prompt="ECHO:should not reach",
                options=make_query_options(
                    pre_agent_downloadables=[
                        RuntimeEnvironmentDownloadableInterface(
                            download_url=f"{base_url}/files/nonexistent",
                            working_dir=working_dir,
                        )
                    ],
                ),
            )


class TestFullInvocationLifecycle:
    """Combined test: download -> pre-command -> agent -> post-command -> artifact upload."""

    async def test_full_invocation_ordering(
        self, ws_url: str, make_query_options, http_server
    ):
        base_url, files, uploads = http_server
        files["runtime.sh"] = b"runtime-payload"
        dl_dir = f"/tmp/dl-lifecycle-{uuid4()}"
        artifacts_dir = f"/tmp/art-lifecycle-{uuid4()}"
        os.makedirs(artifacts_dir, exist_ok=True)

        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        async def on_artifact(
            req: ArtifactUploadRequestMessageInterface,
        ) -> ArtifactUploadResult:
            return ArtifactUploadResult(
                presigned_url=f"{base_url}/uploads/{req.filename}",
                content_type="text/plain",
            )

        client = RuntimeUseClient(ws_url=ws_url)
        result = await client.query(
            prompt=f"WRITE_FILE:{artifacts_dir}/output.txt result-data",
            options=make_query_options(
                pre_agent_downloadables=[
                    RuntimeEnvironmentDownloadableInterface(
                        download_url=f"{base_url}/files/runtime.sh",
                        working_dir=dl_dir,
                    )
                ],
                pre_agent_invocation_commands=[
                    CommandInterface(command=f"cat {dl_dir}/runtime.sh")
                ],
                post_agent_invocation_commands=[
                    CommandInterface(command="echo lifecycle-done")
                ],
                artifacts_dir=artifacts_dir,
                on_artifact_upload_request=on_artifact,
                on_assistant_message=on_msg,
                timeout=20,
            ),
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == f"wrote {artifacts_dir}/output.txt"

        all_text = [block for msg in received for block in msg.text_blocks]
        assert any("runtime-payload" in t for t in all_text), (
            "pre-command should have cat'd the downloaded file"
        )
        assert any("lifecycle-done" in t for t in all_text), (
            "post-command should have run after the agent"
        )

        assert uploads.get("output.txt") == b"result-data"


class TestSecretsRedaction:
    """Verify secrets_to_redact are scrubbed from all outbound messages."""

    async def test_secret_redacted_from_command_output(
        self, client: RuntimeUseClient, make_query_options
    ):
        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        result = await client.query(
            prompt="ECHO:ok",
            options=make_query_options(
                secrets_to_redact=["super-secret-value"],
                pre_agent_invocation_commands=[
                    CommandInterface(command="echo super-secret-value")
                ],
                on_assistant_message=on_msg,
            ),
        )

        assert isinstance(result.data, TextResult)
        all_text = [block for msg in received for block in msg.text_blocks]
        assert not any("super-secret-value" in t for t in all_text)
        assert any("[REDACTED]" in t for t in all_text)

    async def test_secret_redacted_from_assistant_message(
        self, client: RuntimeUseClient, make_query_options
    ):
        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        result = await client.query(
            prompt="STREAM_TEXT:the password is super-secret-value ok",
            options=make_query_options(
                secrets_to_redact=["super-secret-value"],
                on_assistant_message=on_msg,
            ),
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == "done"
        all_text = [block for msg in received for block in msg.text_blocks]
        assert not any("super-secret-value" in t for t in all_text)
        assert any("[REDACTED]" in t for t in all_text)

    async def test_secret_redacted_from_result_text(
        self, client: RuntimeUseClient, make_query_options
    ):
        result = await client.query(
            prompt="ECHO:the key is super-secret-value here",
            options=make_query_options(
                secrets_to_redact=["super-secret-value"],
            ),
        )

        assert isinstance(result.data, TextResult)
        assert "super-secret-value" not in result.data.text
        assert "[REDACTED]" in result.data.text

    async def test_secret_redacted_from_error_message(
        self, client: RuntimeUseClient, make_query_options
    ):
        with pytest.raises(AgentRuntimeError) as exc_info:
            await client.query(
                prompt="ERROR:failed with super-secret-value exposed",
                options=make_query_options(
                    secrets_to_redact=["super-secret-value"],
                ),
            )

        assert "super-secret-value" not in str(exc_info.value)
        assert "[REDACTED]" in str(exc_info.value)


class TestExecuteCommands:
    """Tests for RuntimeUseClient.execute_commands."""

    async def test_single_command_success(
        self, client: RuntimeUseClient, make_execute_commands_options
    ):
        result = await client.execute_commands(
            commands=[CommandInterface(command="echo hello")],
            options=make_execute_commands_options(timeout=10),
        )

        assert isinstance(result, CommandExecutionResult)
        assert len(result.results) == 1
        assert result.results[0].command == "echo hello"
        assert result.results[0].exit_code == 0
        assert result.results[0].stdout is not None
        assert "hello" in result.results[0].stdout

    async def test_multiple_commands_success(
        self, client: RuntimeUseClient, make_execute_commands_options
    ):
        result = await client.execute_commands(
            commands=[
                CommandInterface(command="echo first"),
                CommandInterface(command="echo second"),
            ],
            options=make_execute_commands_options(timeout=10),
        )

        assert len(result.results) == 2
        assert result.results[0].command == "echo first"
        assert result.results[0].exit_code == 0
        assert result.results[0].stdout is not None
        assert "first" in result.results[0].stdout
        assert result.results[1].command == "echo second"
        assert result.results[1].exit_code == 0
        assert result.results[1].stdout is not None
        assert "second" in result.results[1].stdout

    async def test_command_output_streamed_via_callback(
        self, client: RuntimeUseClient, make_execute_commands_options
    ):
        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        await client.execute_commands(
            commands=[CommandInterface(command="echo streamed-sentinel")],
            options=make_execute_commands_options(
                on_assistant_message=on_msg, timeout=10
            ),
        )

        all_text = [block for msg in received for block in msg.text_blocks]
        assert any("streamed-sentinel" in t for t in all_text)

    async def test_failed_command_returns_exit_code(
        self, client: RuntimeUseClient, make_execute_commands_options
    ):
        result = await client.execute_commands(
            commands=[CommandInterface(command="exit 1")],
            options=make_execute_commands_options(timeout=10),
        )

        assert isinstance(result, CommandExecutionResult)
        assert len(result.results) == 1
        assert result.results[0].command == "exit 1"
        assert result.results[0].exit_code == 1
        assert not result.results[0].stdout

    async def test_failed_command_skips_remaining(
        self, client: RuntimeUseClient, make_execute_commands_options
    ):
        result = await client.execute_commands(
            commands=[
                CommandInterface(command="echo first"),
                CommandInterface(command="exit 2"),
                CommandInterface(command="echo should-not-run"),
            ],
            options=make_execute_commands_options(timeout=10),
        )

        assert len(result.results) == 2
        assert result.results[0].command == "echo first"
        assert result.results[0].exit_code == 0
        assert result.results[0].stdout is not None
        assert "first" in result.results[0].stdout
        assert result.results[1].command == "exit 2"
        assert result.results[1].exit_code == 2
        assert not result.results[1].stdout

    async def test_agent_handler_not_invoked(
        self, client: RuntimeUseClient, make_execute_commands_options
    ):
        result = await client.execute_commands(
            commands=[CommandInterface(command="echo no-agent")],
            options=make_execute_commands_options(timeout=10),
        )

        assert isinstance(result, CommandExecutionResult)
        assert len(result.results) == 1

    async def test_command_with_cwd(
        self, client: RuntimeUseClient, make_execute_commands_options
    ):
        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        result = await client.execute_commands(
            commands=[CommandInterface(command="pwd", cwd="/tmp")],
            options=make_execute_commands_options(
                on_assistant_message=on_msg, timeout=10
            ),
        )

        all_text = [block for msg in received for block in msg.text_blocks]
        assert any("/tmp" in t for t in all_text)
        assert result.results[0].stdout is not None
        assert "/tmp" in result.results[0].stdout

    async def test_secrets_redacted_from_output(
        self, client: RuntimeUseClient, make_execute_commands_options
    ):
        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        await client.execute_commands(
            commands=[CommandInterface(command="echo my-secret-token")],
            options=make_execute_commands_options(
                secrets_to_redact=["my-secret-token"],
                on_assistant_message=on_msg,
                timeout=10,
            ),
        )

        all_text = [block for msg in received for block in msg.text_blocks]
        assert not any("my-secret-token" in t for t in all_text)
        assert any("[REDACTED]" in t for t in all_text)

    async def test_cancellation(
        self, ws_url: str, make_execute_commands_options
    ):
        client = RuntimeUseClient(ws_url=ws_url)

        async def abort_on_first(msg: AssistantMessageInterface):
            client.abort()

        with pytest.raises((CancelledException, TimeoutError)):
            await client.execute_commands(
                commands=[
                    CommandInterface(
                        command="for i in $(seq 1 100); do echo line$i; sleep 0.1; done"
                    ),
                ],
                options=make_execute_commands_options(
                    on_assistant_message=abort_on_first, timeout=5
                ),
            )

    async def test_timeout(
        self, client: RuntimeUseClient, make_execute_commands_options
    ):
        with pytest.raises(TimeoutError):
            await client.execute_commands(
                commands=[CommandInterface(command="sleep 30")],
                options=make_execute_commands_options(timeout=0.5),
            )
