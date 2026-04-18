import asyncio
from unittest.mock import AsyncMock
import pytest

from test.conftest import DEFAULT_PROMPT

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
)


STRUCTURED_RESULT_MSG = {
    "message_type": "result_message",
    "data": {"type": "structured_output", "structured_output": {"ok": True}},
    "metadata": None,
}

TEXT_RESULT_MSG = {
    "message_type": "result_message",
    "data": {"type": "text", "text": "Hello, world!"},
    "metadata": None,
}


# ---------------------------------------------------------------------------
# Result message
# ---------------------------------------------------------------------------


class TestResultMessage:
    @pytest.mark.asyncio
    async def test_structured_output_result(self, fake_transport, make_query_options):
        result_msg = {
            "message_type": "result_message",
            "data": {
                "type": "structured_output",
                "structured_output": {"success": True},
            },
            "metadata": {"duration_ms": 50},
        }
        transport, client = fake_transport([result_msg])

        result = await client.query(
            prompt=DEFAULT_PROMPT,
            options=make_query_options(
                output_format_json_schema_str='{"type":"object"}',
            ),
        )

        assert isinstance(result, QueryResult)
        assert isinstance(result.data, StructuredOutputResult)
        assert result.data.structured_output == {"success": True}
        assert result.metadata == {"duration_ms": 50}

    @pytest.mark.asyncio
    async def test_text_result(self, fake_transport, query_options):
        result_msg = {
            "message_type": "result_message",
            "data": {"type": "text", "text": "The answer is 42."},
            "metadata": None,
        }
        transport, client = fake_transport([result_msg])

        result = await client.query(
            prompt=DEFAULT_PROMPT,
            options=query_options,
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == "The answer is 42."

    @pytest.mark.asyncio
    async def test_no_result_raises(self, fake_transport, query_options):
        transport, client = fake_transport([])

        with pytest.raises(AgentRuntimeError, match="No result message received"):
            await client.query(
                prompt=DEFAULT_PROMPT,
                options=query_options,
            )

    @pytest.mark.asyncio
    async def test_missing_result_field_raises(self, fake_transport, query_options):
        result_msg = {
            "message_type": "result_message",
        }
        transport, client = fake_transport([result_msg])

        with pytest.raises(Exception):
            await client.query(
                prompt=DEFAULT_PROMPT,
                options=query_options,
            )


# ---------------------------------------------------------------------------
# Assistant message
# ---------------------------------------------------------------------------


class TestAssistantMessage:
    @pytest.mark.asyncio
    async def test_assistant_message_dispatched(
        self, fake_transport, make_query_options
    ):
        assistant_msg = {
            "message_type": "assistant_message",
            "text_blocks": ["Hello", "World"],
        }
        transport, client = fake_transport([assistant_msg, TEXT_RESULT_MSG])
        on_assistant = AsyncMock()

        await client.query(
            prompt=DEFAULT_PROMPT,
            options=make_query_options(on_assistant_message=on_assistant),
        )

        on_assistant.assert_awaited_once()
        received = on_assistant.call_args[0][0]
        assert isinstance(received, AssistantMessageInterface)
        assert received.text_blocks == ["Hello", "World"]

    @pytest.mark.asyncio
    async def test_assistant_message_ignored_without_callback(
        self, fake_transport, query_options
    ):
        assistant_msg = {
            "message_type": "assistant_message",
            "text_blocks": ["ignored"],
        }
        transport, client = fake_transport([assistant_msg, TEXT_RESULT_MSG])

        await client.query(
            prompt=DEFAULT_PROMPT,
            options=query_options,
        )


# ---------------------------------------------------------------------------
# Error message
# ---------------------------------------------------------------------------


class TestErrorMessage:
    @pytest.mark.asyncio
    async def test_error_message_raises(self, fake_transport, query_options):
        error_msg = {
            "message_type": "error_message",
            "error": "something broke",
            "metadata": {"code": 500},
        }
        transport, client = fake_transport([error_msg])

        with pytest.raises(AgentRuntimeError, match="something broke") as exc_info:
            await client.query(
                prompt=DEFAULT_PROMPT,
                options=query_options,
            )

        assert exc_info.value.error == "something broke"
        assert exc_info.value.metadata == {"code": 500}

    @pytest.mark.asyncio
    async def test_error_without_metadata(self, fake_transport, query_options):
        error_msg = {
            "message_type": "error_message",
            "error": "oops",
        }
        transport, client = fake_transport([error_msg])

        with pytest.raises(AgentRuntimeError, match="oops") as exc_info:
            await client.query(
                prompt=DEFAULT_PROMPT,
                options=query_options,
            )

        assert exc_info.value.error == "oops"
        assert exc_info.value.metadata is None


# ---------------------------------------------------------------------------
# Artifact upload handshake
# ---------------------------------------------------------------------------


class TestArtifactUpload:
    @pytest.mark.asyncio
    async def test_artifact_upload_handshake(self, fake_transport, make_query_options):
        upload_request = {
            "message_type": "artifact_upload_request_message",
            "filename": "screenshot.png",
            "filepath": "/tmp/screenshot.png",
        }
        transport, client = fake_transport([upload_request, TEXT_RESULT_MSG])

        async def on_artifact(
            req: ArtifactUploadRequestMessageInterface,
        ) -> ArtifactUploadResult:
            assert req.filename == "screenshot.png"
            return ArtifactUploadResult(
                presigned_url="https://s3.example.com/presigned",
                content_type="image/png",
            )

        await client.query(
            prompt=DEFAULT_PROMPT,
            options=make_query_options(
                artifacts_dir="/tmp/artifacts",
                on_artifact_upload_request=on_artifact,
            ),
        )

        response_msgs = [
            m
            for m in transport.sent
            if m.get("message_type") == "artifact_upload_response_message"
        ]
        assert len(response_msgs) == 1
        resp = response_msgs[0]
        assert resp["filename"] == "screenshot.png"
        assert resp["filepath"] == "/tmp/screenshot.png"
        assert resp["presigned_url"] == "https://s3.example.com/presigned"
        assert resp["content_type"] == "image/png"

    @pytest.mark.asyncio
    async def test_artifact_upload_ignored_without_callback(
        self, fake_transport, query_options
    ):
        upload_request = {
            "message_type": "artifact_upload_request_message",
            "filename": "file.txt",
            "filepath": "/tmp/file.txt",
        }
        transport, client = fake_transport([upload_request, TEXT_RESULT_MSG])

        await client.query(
            prompt=DEFAULT_PROMPT,
            options=query_options,
        )


# ---------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------


class TestCancellation:
    @pytest.mark.asyncio
    async def test_abort_raises(self, fake_transport, make_query_options):
        filler_msg = {
            "message_type": "assistant_message",
            "text_blocks": ["working..."],
        }

        transport, client = fake_transport([filler_msg, filler_msg])

        async def abort_on_first_message(_msg):
            client.abort()

        with pytest.raises(CancelledException):
            await client.query(
                prompt=DEFAULT_PROMPT,
                options=make_query_options(
                    on_assistant_message=abort_on_first_message,
                ),
            )

    @pytest.mark.asyncio
    async def test_no_cancellation_without_abort(self, fake_transport, query_options):
        transport, client = fake_transport([TEXT_RESULT_MSG])

        result = await client.query(
            prompt=DEFAULT_PROMPT,
            options=query_options,
        )

        assert isinstance(result.data, TextResult)
        assert result.data.text == "Hello, world!"


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------


class TestTimeout:
    @pytest.mark.asyncio
    async def test_timeout_raises(self, make_query_options):
        async def stalling_transport(
            send_queue: asyncio.Queue[dict],
        ):
            await asyncio.sleep(10)
            yield {}  # pragma: no cover

        client = RuntimeUseClient(transport=stalling_transport)

        with pytest.raises(TimeoutError):
            await client.query(
                prompt=DEFAULT_PROMPT,
                options=make_query_options(timeout=0.05),
            )


# ---------------------------------------------------------------------------
# Unknown / malformed messages
# ---------------------------------------------------------------------------


class TestUnknownMessages:
    @pytest.mark.asyncio
    async def test_unknown_message_type_skipped(self, fake_transport, query_options):
        unknown_msg = {"message_type": "unknown_type", "data": 123}
        transport, client = fake_transport([unknown_msg, TEXT_RESULT_MSG])

        result = await client.query(
            prompt=DEFAULT_PROMPT,
            options=query_options,
        )

        assert isinstance(result.data, TextResult)

    @pytest.mark.asyncio
    async def test_completely_malformed_message_skipped(
        self, fake_transport, query_options
    ):
        bad_msg = {"no_message_type_key": True}
        transport, client = fake_transport([bad_msg, TEXT_RESULT_MSG])

        result = await client.query(
            prompt=DEFAULT_PROMPT,
            options=query_options,
        )

        assert isinstance(result.data, TextResult)


# ---------------------------------------------------------------------------
# Multiple messages in sequence
# ---------------------------------------------------------------------------


class TestMultipleMessages:
    @pytest.mark.asyncio
    async def test_full_message_sequence(self, fake_transport, make_query_options):
        messages = [
            {
                "message_type": "assistant_message",
                "text_blocks": ["Starting..."],
            },
            {
                "message_type": "assistant_message",
                "text_blocks": ["Still working..."],
            },
            {
                "message_type": "result_message",
                "data": {
                    "type": "structured_output",
                    "structured_output": {"answer": 42},
                },
                "metadata": {"duration_ms": 100},
            },
        ]
        transport, client = fake_transport(messages)

        on_assistant = AsyncMock()

        result = await client.query(
            prompt=DEFAULT_PROMPT,
            options=make_query_options(on_assistant_message=on_assistant),
        )

        assert on_assistant.await_count == 2
        assert isinstance(result.data, StructuredOutputResult)
        assert result.data.structured_output == {"answer": 42}


# ---------------------------------------------------------------------------
# Invocation message is sent to the transport
# ---------------------------------------------------------------------------


class TestInvocationSent:
    @pytest.mark.asyncio
    async def test_invocation_message_queued(self, fake_transport, make_query_options):
        transport, client = fake_transport([TEXT_RESULT_MSG])

        await client.query(
            prompt="Do something.",
            options=make_query_options(source_id="capture-test"),
        )

        invocation_msgs = [
            m for m in transport.sent if m.get("message_type") == "invocation_message"
        ]
        assert len(invocation_msgs) == 1
        assert invocation_msgs[0]["source_id"] == "capture-test"
        assert invocation_msgs[0]["user_prompt"] == "Do something."

    @pytest.mark.asyncio
    async def test_schema_forwarded_when_set(self, fake_transport, make_query_options):
        transport, client = fake_transport([STRUCTURED_RESULT_MSG])

        await client.query(
            prompt=DEFAULT_PROMPT,
            options=make_query_options(
                output_format_json_schema_str='{"type":"object"}',
            ),
        )

        invocation_msgs = [
            m for m in transport.sent if m.get("message_type") == "invocation_message"
        ]
        assert (
            invocation_msgs[0]["output_format_json_schema_str"] == '{"type":"object"}'
        )

    @pytest.mark.asyncio
    async def test_agent_env_forwarded_when_set(
        self, fake_transport, make_query_options
    ):
        transport, client = fake_transport([TEXT_RESULT_MSG])

        await client.query(
            prompt=DEFAULT_PROMPT,
            options=make_query_options(agent_env={"MY_VAR": "hello"}),
        )

        invocation_msgs = [
            m for m in transport.sent if m.get("message_type") == "invocation_message"
        ]
        assert invocation_msgs[0]["agent_env"] == {"MY_VAR": "hello"}

    @pytest.mark.asyncio
    async def test_agent_env_none_when_omitted(self, fake_transport, query_options):
        transport, client = fake_transport([TEXT_RESULT_MSG])

        await client.query(
            prompt=DEFAULT_PROMPT,
            options=query_options,
        )

        invocation_msgs = [
            m for m in transport.sent if m.get("message_type") == "invocation_message"
        ]
        assert invocation_msgs[0]["agent_env"] is None

    @pytest.mark.asyncio
    async def test_schema_none_when_omitted(self, fake_transport, query_options):
        transport, client = fake_transport([TEXT_RESULT_MSG])

        await client.query(
            prompt=DEFAULT_PROMPT,
            options=query_options,
        )

        invocation_msgs = [
            m for m in transport.sent if m.get("message_type") == "invocation_message"
        ]
        assert invocation_msgs[0]["output_format_json_schema_str"] is None


# ---------------------------------------------------------------------------
# Constructor validation
# ---------------------------------------------------------------------------


class TestConstructor:
    def test_requires_ws_url_or_transport(self):
        with pytest.raises(ValueError, match="Either ws_url or transport"):
            RuntimeUseClient()

    def test_accepts_ws_url(self):
        client = RuntimeUseClient(ws_url="ws://localhost:8080")
        assert client is not None

    def test_accepts_transport(self, fake_transport):
        transport, client = fake_transport([])
        assert client is not None

    def test_artifacts_dir_requires_callback(self, make_query_options):
        with pytest.raises(ValueError, match="must be specified together"):
            make_query_options(artifacts_dir="/tmp/artifacts")

        async def _dummy_cb(req):
            return ArtifactUploadResult(
                presigned_url="https://example.com", content_type="text/plain"
            )

        with pytest.raises(ValueError, match="must be specified together"):
            make_query_options(on_artifact_upload_request=_dummy_cb)

        opts = make_query_options(
            artifacts_dir="/tmp/artifacts", on_artifact_upload_request=_dummy_cb
        )
        assert opts.artifacts_dir == "/tmp/artifacts"
        assert opts.on_artifact_upload_request is _dummy_cb


# ---------------------------------------------------------------------------
# execute_commands
# ---------------------------------------------------------------------------

COMMAND_RESULT_MSG = {
    "message_type": "command_execution_result_message",
    "results": [{"command": "echo hello", "exit_code": 0, "stdout": "hello\n"}],
}


class TestExecuteCommands:
    @pytest.mark.asyncio
    async def test_returns_command_execution_result(
        self, fake_transport, make_execute_commands_options
    ):
        transport, client = fake_transport([COMMAND_RESULT_MSG])

        result = await client.execute_commands(
            commands=[CommandInterface(command="echo hello")],
            options=make_execute_commands_options(),
        )

        assert isinstance(result, CommandExecutionResult)
        assert len(result.results) == 1
        assert result.results[0].command == "echo hello"
        assert result.results[0].exit_code == 0
        assert result.results[0].stdout == "hello\n"

    @pytest.mark.asyncio
    async def test_sends_command_execution_message(
        self, fake_transport, make_execute_commands_options
    ):
        transport, client = fake_transport([COMMAND_RESULT_MSG])

        await client.execute_commands(
            commands=[CommandInterface(command="echo hello")],
            options=make_execute_commands_options(source_id="cmd-test"),
        )

        cmd_msgs = [
            m
            for m in transport.sent
            if m.get("message_type") == "command_execution_message"
        ]
        assert len(cmd_msgs) == 1
        assert cmd_msgs[0]["source_id"] == "cmd-test"
        assert cmd_msgs[0]["commands"] == [
            {"command": "echo hello", "cwd": None, "env": None}
        ]

    @pytest.mark.asyncio
    async def test_assistant_message_dispatched(
        self, fake_transport, make_execute_commands_options
    ):
        assistant_msg = {
            "message_type": "assistant_message",
            "text_blocks": ["output line"],
        }
        transport, client = fake_transport([assistant_msg, COMMAND_RESULT_MSG])
        on_assistant = AsyncMock()

        await client.execute_commands(
            commands=[CommandInterface(command="echo hello")],
            options=make_execute_commands_options(on_assistant_message=on_assistant),
        )

        on_assistant.assert_awaited_once()
        received = on_assistant.call_args[0][0]
        assert isinstance(received, AssistantMessageInterface)
        assert received.text_blocks == ["output line"]

    @pytest.mark.asyncio
    async def test_error_message_raises(
        self, fake_transport, make_execute_commands_options
    ):
        error_msg = {
            "message_type": "error_message",
            "error": "something went wrong",
            "metadata": {},
        }
        transport, client = fake_transport([error_msg])

        with pytest.raises(AgentRuntimeError, match="something went wrong"):
            await client.execute_commands(
                commands=[CommandInterface(command="echo hello")],
                options=make_execute_commands_options(),
            )

    @pytest.mark.asyncio
    async def test_non_zero_exit_code_returns_result(
        self, fake_transport, make_execute_commands_options
    ):
        result_msg = {
            "message_type": "command_execution_result_message",
            "results": [{"command": "exit 1", "exit_code": 1}],
        }
        transport, client = fake_transport([result_msg])

        result = await client.execute_commands(
            commands=[CommandInterface(command="exit 1")],
            options=make_execute_commands_options(),
        )

        assert isinstance(result, CommandExecutionResult)
        assert len(result.results) == 1
        assert result.results[0].exit_code == 1
        assert result.results[0].stdout is None

    @pytest.mark.asyncio
    async def test_failed_command_skips_remaining(
        self, fake_transport, make_execute_commands_options
    ):
        result_msg = {
            "message_type": "command_execution_result_message",
            "results": [
                {"command": "echo first", "exit_code": 0, "stdout": "first\n"},
                {"command": "exit 1", "exit_code": 1},
            ],
        }
        transport, client = fake_transport([result_msg])

        result = await client.execute_commands(
            commands=[
                CommandInterface(command="echo first"),
                CommandInterface(command="exit 1"),
                CommandInterface(command="echo skipped"),
            ],
            options=make_execute_commands_options(),
        )

        assert len(result.results) == 2
        assert result.results[0].exit_code == 0
        assert result.results[0].stdout == "first\n"
        assert result.results[1].exit_code == 1
        assert result.results[1].stdout is None

    @pytest.mark.asyncio
    async def test_no_result_raises(
        self, fake_transport, make_execute_commands_options
    ):
        transport, client = fake_transport([])

        with pytest.raises(AgentRuntimeError, match="No result message received"):
            await client.execute_commands(
                commands=[CommandInterface(command="echo hello")],
                options=make_execute_commands_options(),
            )

    @pytest.mark.asyncio
    async def test_abort_raises_cancelled(
        self, fake_transport, make_execute_commands_options
    ):
        filler_msg = {
            "message_type": "assistant_message",
            "text_blocks": ["working..."],
        }
        transport, client = fake_transport([filler_msg, filler_msg])

        async def abort_on_first_message(_msg):
            client.abort()

        with pytest.raises(CancelledException):
            await client.execute_commands(
                commands=[CommandInterface(command="echo hello")],
                options=make_execute_commands_options(
                    on_assistant_message=abort_on_first_message
                ),
            )

    @pytest.mark.asyncio
    async def test_timeout_raises(self, make_execute_commands_options):
        async def stalling_transport(send_queue: asyncio.Queue[dict]):
            await asyncio.sleep(10)
            yield {}

        client = RuntimeUseClient(transport=stalling_transport)

        with pytest.raises(TimeoutError):
            await client.execute_commands(
                commands=[CommandInterface(command="echo hello")],
                options=make_execute_commands_options(timeout=0.05),
            )

    @pytest.mark.asyncio
    async def test_artifact_upload_handshake(
        self, fake_transport, make_execute_commands_options
    ):
        upload_request = {
            "message_type": "artifact_upload_request_message",
            "filename": "output.txt",
            "filepath": "/tmp/output.txt",
        }
        transport, client = fake_transport([upload_request, COMMAND_RESULT_MSG])

        async def on_artifact(
            req: ArtifactUploadRequestMessageInterface,
        ) -> ArtifactUploadResult:
            return ArtifactUploadResult(
                presigned_url="https://s3.example.com/presigned",
                content_type="text/plain",
            )

        await client.execute_commands(
            commands=[CommandInterface(command="echo hello")],
            options=make_execute_commands_options(
                artifacts_dir="/tmp/artifacts",
                on_artifact_upload_request=on_artifact,
            ),
        )

        response_msgs = [
            m
            for m in transport.sent
            if m.get("message_type") == "artifact_upload_response_message"
        ]
        assert len(response_msgs) == 1
        assert response_msgs[0]["filename"] == "output.txt"
        assert response_msgs[0]["presigned_url"] == "https://s3.example.com/presigned"

    @pytest.mark.asyncio
    async def test_command_env_forwarded(
        self, fake_transport, make_execute_commands_options
    ):
        result_msg = {
            "message_type": "command_execution_result_message",
            "results": [{"command": "echo hello", "exit_code": 0, "stdout": "hello\n"}],
        }
        transport, client = fake_transport([result_msg])

        await client.execute_commands(
            commands=[CommandInterface(command="echo hello", env={"FOO": "bar"})],
            options=make_execute_commands_options(),
        )

        cmd_msgs = [
            m
            for m in transport.sent
            if m.get("message_type") == "command_execution_message"
        ]
        assert len(cmd_msgs) == 1
        assert cmd_msgs[0]["commands"] == [
            {"command": "echo hello", "cwd": None, "env": {"FOO": "bar"}}
        ]

    @pytest.mark.asyncio
    async def test_command_env_none_by_default(
        self, fake_transport, make_execute_commands_options
    ):
        transport, client = fake_transport([COMMAND_RESULT_MSG])

        await client.execute_commands(
            commands=[CommandInterface(command="echo hello")],
            options=make_execute_commands_options(),
        )

        cmd_msgs = [
            m
            for m in transport.sent
            if m.get("message_type") == "command_execution_message"
        ]
        assert cmd_msgs[0]["commands"][0]["env"] is None

    def test_execute_commands_options_artifacts_validation(self):
        with pytest.raises(ValueError, match="must be specified together"):
            ExecuteCommandsOptions(artifacts_dir="/tmp/artifacts")

        async def _dummy_cb(req):
            return ArtifactUploadResult(
                presigned_url="https://example.com", content_type="text/plain"
            )

        with pytest.raises(ValueError, match="must be specified together"):
            ExecuteCommandsOptions(on_artifact_upload_request=_dummy_cb)


# ---------------------------------------------------------------------------
# Persistent session
# ---------------------------------------------------------------------------


TEXT_RESULT_MSG_PERSISTENT = {
    "message_type": "result_message",
    "data": {"type": "text", "text": "persistent hello"},
    "metadata": None,
}


class TestPersistentSession:
    @pytest.mark.asyncio
    async def test_two_sequential_queries_share_one_connection(
        self, fake_persistent_transport, make_query_options
    ):
        transport, client = fake_persistent_transport(
            [
                [
                    {
                        "message_type": "result_message",
                        "data": {"type": "text", "text": "first"},
                        "metadata": None,
                    }
                ],
                [
                    {
                        "message_type": "result_message",
                        "data": {"type": "text", "text": "second"},
                        "metadata": None,
                    }
                ],
            ]
        )

        async with client.session() as session:
            first = await session.query(
                prompt="one", options=make_query_options(source_id="a")
            )
            second = await session.query(
                prompt="two", options=make_query_options(source_id="b")
            )

        assert first.data.text == "first"
        assert second.data.text == "second"
        assert transport.closed is True

        invocation_msgs = [
            m for m in transport.sent if m.get("message_type") == "invocation_message"
        ]
        assert [m["source_id"] for m in invocation_msgs] == ["a", "b"]

    @pytest.mark.asyncio
    async def test_mixed_query_and_execute_commands_in_one_session(
        self, fake_persistent_transport, make_query_options, make_execute_commands_options
    ):
        transport, client = fake_persistent_transport(
            [
                [TEXT_RESULT_MSG_PERSISTENT],
                [
                    {
                        "message_type": "command_execution_result_message",
                        "results": [{"command": "echo x", "exit_code": 0, "stdout": "x\n"}],
                    }
                ],
            ]
        )

        async with client.session() as session:
            query_result = await session.query(
                prompt="hello", options=make_query_options()
            )
            cmd_result = await session.execute_commands(
                commands=[CommandInterface(command="echo x")],
                options=make_execute_commands_options(),
            )

        assert query_result.data.text == "persistent hello"
        assert cmd_result.results[0].command == "echo x"
        assert cmd_result.results[0].stdout == "x\n"

    @pytest.mark.asyncio
    async def test_cancel_mid_session_then_another_call(
        self, fake_persistent_transport, make_query_options
    ):
        filler_msg = {
            "message_type": "assistant_message",
            "text_blocks": ["working..."],
        }

        transport, client = fake_persistent_transport(
            [
                [filler_msg, filler_msg],
                [
                    {
                        "message_type": "result_message",
                        "data": {"type": "text", "text": "after cancel"},
                        "metadata": None,
                    }
                ],
            ]
        )

        async with client.session() as session:
            async def abort_on_first(_msg):
                session.abort()

            with pytest.raises(CancelledException):
                await session.query(
                    prompt="first",
                    options=make_query_options(on_assistant_message=abort_on_first),
                )

            second = await session.query(
                prompt="second", options=make_query_options()
            )

        assert second.data.text == "after cancel"
        # The aborted call sent a cancel_message to the server
        cancel_msgs = [
            m for m in transport.sent if m.get("message_type") == "cancel_message"
        ]
        assert len(cancel_msgs) == 1

    @pytest.mark.asyncio
    async def test_per_call_abort_targets_in_flight_request_only(
        self, fake_persistent_transport, make_query_options
    ):
        filler_msg = {
            "message_type": "assistant_message",
            "text_blocks": ["tick"],
        }

        transport, client = fake_persistent_transport(
            [
                [TEXT_RESULT_MSG_PERSISTENT],
                [filler_msg, filler_msg],
            ]
        )

        async with client.session() as session:
            first = await session.query(
                prompt="one", options=make_query_options()
            )
            assert first.data.text == "persistent hello"

            async def abort_on_first(_msg):
                session.abort()

            with pytest.raises(CancelledException):
                await session.query(
                    prompt="two",
                    options=make_query_options(on_assistant_message=abort_on_first),
                )

        cancel_msgs = [
            m for m in transport.sent if m.get("message_type") == "cancel_message"
        ]
        assert len(cancel_msgs) == 1

    @pytest.mark.asyncio
    async def test_session_closes_transport_on_exit(
        self, fake_persistent_transport, make_query_options
    ):
        transport, client = fake_persistent_transport([[TEXT_RESULT_MSG_PERSISTENT]])

        async with client.session() as session:
            await session.query(prompt="hi", options=make_query_options())

        assert transport.closed is True


class _StaleBufferTransport:
    """Simulates a real WebSocket: a single FIFO feeds all request() calls.

    If a request() generator is closed early (e.g., the client aborts), any
    messages not yet consumed stay in the buffer and are the first thing the
    next request() sees. This mirrors real websockets library behaviour.
    """

    def __init__(self, messages: list[dict]):
        self._queue: asyncio.Queue[dict] = asyncio.Queue()
        for m in messages:
            self._queue.put_nowait(m)
        self.sent: list[dict] = []
        self.closed = False

    def _drain_send(self, send_queue: asyncio.Queue[dict]) -> None:
        while not send_queue.empty():
            self.sent.append(send_queue.get_nowait())
            send_queue.task_done()

    async def request(self, send_queue: asyncio.Queue[dict]):
        try:
            while True:
                self._drain_send(send_queue)
                if self._queue.empty():
                    return
                yield self._queue.get_nowait()
        finally:
            self._drain_send(send_queue)

    async def end_session(self, on_message=None, timeout_s: float = 60.0) -> None:
        return None

    async def close(self) -> None:
        self.closed = True

    def connect(self):
        transport = self

        class _Ctx:
            async def __aenter__(self):
                return transport

            async def __aexit__(self, exc_type, exc, tb):
                await transport.close()

        return _Ctx()


class TestStaleTerminalDraining:
    @pytest.mark.asyncio
    async def test_cancelled_request_drains_server_terminal_before_next_call(
        self, make_query_options
    ):
        # Scenario: request 1 is aborted mid-flight. The server processes the
        # cancel and sends an error_message terminal. That terminal must be
        # consumed by request 1's loop - NOT leak into request 2.
        filler = {"message_type": "assistant_message", "text_blocks": ["tick"]}
        cancel_terminal = {
            "message_type": "error_message",
            "error": "Request cancelled",
            "metadata": {},
        }
        result_after = {
            "message_type": "result_message",
            "data": {"type": "text", "text": "clean"},
            "metadata": None,
        }

        transport = _StaleBufferTransport(
            [filler, cancel_terminal, result_after]
        )
        client = RuntimeUseClient(transport=transport)

        async with client.session() as session:
            async def abort_on_first(_msg):
                session.abort()

            with pytest.raises(CancelledException):
                await session.query(
                    prompt="one",
                    options=make_query_options(on_assistant_message=abort_on_first),
                )

            # Second request must NOT see the stale cancel_terminal.
            second = await session.query(
                prompt="two", options=make_query_options()
            )

        assert second.data.text == "clean"
