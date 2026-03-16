"""End-to-end tests for RuntimeUseClient against a local runtimeuse server
with the deterministic echo handler."""

import json
from uuid import uuid4

import pytest

from src.runtimeuse_client import (
    RuntimeUseClient,
    QueryOptions,
    QueryResult,
    TextResult,
    StructuredOutputResult,
    AssistantMessageInterface,
    ArtifactUploadRequestMessageInterface,
    ArtifactUploadResult,
    AgentRuntimeError,
    CancelledException,
    CommandInterface,
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
