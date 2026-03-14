import asyncio
from unittest.mock import AsyncMock
import pytest

from test.conftest import DEFAULT_PROMPT

from src.runtimeuse_client import (
    RuntimeUseClient,
    QueryOptions,
    ResultMessageInterface,
    AssistantMessageInterface,
    ArtifactUploadRequestMessageInterface,
    ArtifactUploadResult,
    ErrorMessageInterface,
    AgentRuntimeError,
    CancelledException,
)


RESULT_MSG = {
    "message_type": "result_message",
    "structured_output": {"ok": True},
    "metadata": None,
}


# ---------------------------------------------------------------------------
# Result message
# ---------------------------------------------------------------------------


class TestResultMessage:
    @pytest.mark.asyncio
    async def test_result_message_returned(self, fake_transport, query_options):
        result_msg = {
            "message_type": "result_message",
            "structured_output": {"success": True},
            "metadata": None,
        }
        transport, client = fake_transport([result_msg])

        result = await client.query(
            prompt=DEFAULT_PROMPT,
            options=query_options,
        )

        assert isinstance(result, ResultMessageInterface)
        assert result.structured_output == {"success": True}

    @pytest.mark.asyncio
    async def test_no_result_raises(self, fake_transport, query_options):
        transport, client = fake_transport([])

        with pytest.raises(AgentRuntimeError, match="No result message received"):
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
        transport, client = fake_transport([assistant_msg, RESULT_MSG])
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
        transport, client = fake_transport([assistant_msg, RESULT_MSG])

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
        result_msg = {
            "message_type": "result_message",
            "structured_output": {"done": True},
            "metadata": None,
        }
        transport, client = fake_transport([upload_request, result_msg])

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
            options=make_query_options(on_artifact_upload_request=on_artifact),
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
        transport, client = fake_transport([upload_request, RESULT_MSG])

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
        result_msg = {
            "message_type": "result_message",
            "structured_output": {"ok": True},
            "metadata": None,
        }

        transport, client = fake_transport([result_msg])

        result = await client.query(
            prompt=DEFAULT_PROMPT,
            options=query_options,
        )

        assert result.structured_output == {"ok": True}


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
        transport, client = fake_transport([unknown_msg, RESULT_MSG])

        result = await client.query(
            prompt=DEFAULT_PROMPT,
            options=query_options,
        )

        assert result.structured_output == {"ok": True}

    @pytest.mark.asyncio
    async def test_completely_malformed_message_skipped(
        self, fake_transport, query_options
    ):
        bad_msg = {"no_message_type_key": True}
        transport, client = fake_transport([bad_msg, RESULT_MSG])

        result = await client.query(
            prompt=DEFAULT_PROMPT,
            options=query_options,
        )

        assert result.structured_output == {"ok": True}


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
                "structured_output": {"answer": 42},
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
        assert result.structured_output == {"answer": 42}


# ---------------------------------------------------------------------------
# Invocation message is sent to the transport
# ---------------------------------------------------------------------------


class TestInvocationSent:
    @pytest.mark.asyncio
    async def test_invocation_message_queued(self, fake_transport, make_query_options):
        transport, client = fake_transport([RESULT_MSG])

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
