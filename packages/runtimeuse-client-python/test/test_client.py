import asyncio
from unittest.mock import AsyncMock
import pytest


from src.runtimeuse_client import (
    RuntimeUseClient,
    ResultMessageInterface,
    AssistantMessageInterface,
    ArtifactUploadRequestMessageInterface,
    ArtifactUploadResult,
    ErrorMessageInterface,
    CancelledException,
)


# ---------------------------------------------------------------------------
# Result message
# ---------------------------------------------------------------------------


class TestResultMessage:
    @pytest.mark.asyncio
    async def test_result_message_dispatched(self, fake_transport, invocation):
        result_msg = {
            "message_type": "result_message",
            "structured_output": {"success": True},
            "metadata": None,
        }
        transport, client = fake_transport([result_msg])
        on_result = AsyncMock()

        await client.invoke(
            invocation=invocation,
            on_result_message=on_result,
            result_message_cls=ResultMessageInterface,
        )

        on_result.assert_awaited_once()
        received = on_result.call_args[0][0]
        assert isinstance(received, ResultMessageInterface)
        assert received.structured_output == {"success": True}

    @pytest.mark.asyncio
    async def test_custom_result_class(self, fake_transport, invocation):
        class CustomResult(ResultMessageInterface):
            custom_field: str = "default"

        result_msg = {
            "message_type": "result_message",
            "structured_output": {"ok": 1},
            "metadata": None,
            "custom_field": "hello",
        }
        transport, client = fake_transport([result_msg])
        on_result = AsyncMock()

        await client.invoke(
            invocation=invocation,
            on_result_message=on_result,
            result_message_cls=CustomResult,
        )

        received = on_result.call_args[0][0]
        assert isinstance(received, CustomResult)
        assert received.custom_field == "hello"


# ---------------------------------------------------------------------------
# Assistant message
# ---------------------------------------------------------------------------


class TestAssistantMessage:
    @pytest.mark.asyncio
    async def test_assistant_message_dispatched(self, fake_transport, invocation):
        assistant_msg = {
            "message_type": "assistant_message",
            "text_blocks": ["Hello", "World"],
        }
        transport, client = fake_transport([assistant_msg])
        on_assistant = AsyncMock()

        await client.invoke(
            invocation=invocation,
            on_result_message=AsyncMock(),
            result_message_cls=ResultMessageInterface,
            on_assistant_message=on_assistant,
        )

        on_assistant.assert_awaited_once()
        received = on_assistant.call_args[0][0]
        assert isinstance(received, AssistantMessageInterface)
        assert received.text_blocks == ["Hello", "World"]

    @pytest.mark.asyncio
    async def test_assistant_message_ignored_without_callback(
        self, fake_transport, invocation
    ):
        assistant_msg = {
            "message_type": "assistant_message",
            "text_blocks": ["ignored"],
        }
        transport, client = fake_transport([assistant_msg])

        await client.invoke(
            invocation=invocation,
            on_result_message=AsyncMock(),
            result_message_cls=ResultMessageInterface,
            on_assistant_message=None,
        )


# ---------------------------------------------------------------------------
# Error message
# ---------------------------------------------------------------------------


class TestErrorMessage:
    @pytest.mark.asyncio
    async def test_error_message_dispatched(self, fake_transport, invocation):
        error_msg = {
            "message_type": "error_message",
            "error": "something broke",
            "metadata": {"code": 500},
        }
        transport, client = fake_transport([error_msg])
        on_error = AsyncMock()

        await client.invoke(
            invocation=invocation,
            on_result_message=AsyncMock(),
            result_message_cls=ResultMessageInterface,
            on_error_message=on_error,
        )

        on_error.assert_awaited_once()
        received = on_error.call_args[0][0]
        assert isinstance(received, ErrorMessageInterface)
        assert received.error == "something broke"
        assert received.metadata == {"code": 500}

    @pytest.mark.asyncio
    async def test_error_message_ignored_without_callback(
        self, fake_transport, invocation
    ):
        error_msg = {
            "message_type": "error_message",
            "error": "ignored",
        }
        transport, client = fake_transport([error_msg])

        await client.invoke(
            invocation=invocation,
            on_result_message=AsyncMock(),
            result_message_cls=ResultMessageInterface,
            on_error_message=None,
        )


# ---------------------------------------------------------------------------
# Artifact upload handshake
# ---------------------------------------------------------------------------


class TestArtifactUpload:
    @pytest.mark.asyncio
    async def test_artifact_upload_handshake(self, fake_transport, invocation):
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

        await client.invoke(
            invocation=invocation,
            on_result_message=AsyncMock(),
            result_message_cls=ResultMessageInterface,
            on_artifact_upload_request=on_artifact,
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
        self, fake_transport, invocation
    ):
        upload_request = {
            "message_type": "artifact_upload_request_message",
            "filename": "file.txt",
            "filepath": "/tmp/file.txt",
        }
        transport, client = fake_transport([upload_request])

        await client.invoke(
            invocation=invocation,
            on_result_message=AsyncMock(),
            result_message_cls=ResultMessageInterface,
            on_artifact_upload_request=None,
        )


# ---------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------


class TestCancellation:
    @pytest.mark.asyncio
    async def test_cancellation_raises(self, fake_transport, invocation):
        filler_msg = {
            "message_type": "assistant_message",
            "text_blocks": ["working..."],
        }

        cancel_called = False

        async def is_cancelled() -> bool:
            nonlocal cancel_called
            if cancel_called:
                return True
            cancel_called = True
            return False

        transport, client = fake_transport([filler_msg, filler_msg])

        with pytest.raises(CancelledException):
            await client.invoke(
                invocation=invocation,
                on_result_message=AsyncMock(),
                result_message_cls=ResultMessageInterface,
                is_cancelled=is_cancelled,
            )

    @pytest.mark.asyncio
    async def test_no_cancellation_when_callback_returns_false(
        self, fake_transport, invocation
    ):
        result_msg = {
            "message_type": "result_message",
            "structured_output": {"ok": True},
            "metadata": None,
        }

        async def is_cancelled() -> bool:
            return False

        transport, client = fake_transport([result_msg])
        on_result = AsyncMock()

        await client.invoke(
            invocation=invocation,
            on_result_message=on_result,
            result_message_cls=ResultMessageInterface,
            is_cancelled=is_cancelled,
        )

        on_result.assert_awaited_once()


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------


class TestTimeout:
    @pytest.mark.asyncio
    async def test_timeout_raises(self, invocation):
        async def stalling_transport(
            send_queue: asyncio.Queue[dict],
        ):
            await asyncio.sleep(10)
            yield {}  # pragma: no cover

        client = RuntimeUseClient(transport=stalling_transport)

        with pytest.raises(TimeoutError):
            await client.invoke(
                invocation=invocation,
                on_result_message=AsyncMock(),
                result_message_cls=ResultMessageInterface,
                timeout=0.05,
            )


# ---------------------------------------------------------------------------
# Unknown / malformed messages
# ---------------------------------------------------------------------------


class TestUnknownMessages:
    @pytest.mark.asyncio
    async def test_unknown_message_type_skipped(self, fake_transport, invocation):
        unknown_msg = {"message_type": "unknown_type", "data": 123}
        result_msg = {
            "message_type": "result_message",
            "structured_output": {"ok": True},
            "metadata": None,
        }
        transport, client = fake_transport([unknown_msg, result_msg])
        on_result = AsyncMock()

        await client.invoke(
            invocation=invocation,
            on_result_message=on_result,
            result_message_cls=ResultMessageInterface,
        )

        on_result.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_completely_malformed_message_skipped(
        self, fake_transport, invocation
    ):
        bad_msg = {"no_message_type_key": True}
        result_msg = {
            "message_type": "result_message",
            "structured_output": {"ok": True},
            "metadata": None,
        }
        transport, client = fake_transport([bad_msg, result_msg])
        on_result = AsyncMock()

        await client.invoke(
            invocation=invocation,
            on_result_message=on_result,
            result_message_cls=ResultMessageInterface,
        )

        on_result.assert_awaited_once()


# ---------------------------------------------------------------------------
# Multiple messages in sequence
# ---------------------------------------------------------------------------


class TestMultipleMessages:
    @pytest.mark.asyncio
    async def test_full_message_sequence(self, fake_transport, invocation):
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
                "message_type": "error_message",
                "error": "non-fatal warning",
                "metadata": None,
            },
            {
                "message_type": "result_message",
                "structured_output": {"answer": 42},
                "metadata": {"duration_ms": 100},
            },
        ]
        transport, client = fake_transport(messages)

        on_result = AsyncMock()
        on_assistant = AsyncMock()
        on_error = AsyncMock()

        await client.invoke(
            invocation=invocation,
            on_result_message=on_result,
            result_message_cls=ResultMessageInterface,
            on_assistant_message=on_assistant,
            on_error_message=on_error,
        )

        assert on_assistant.await_count == 2
        on_error.assert_awaited_once()
        on_result.assert_awaited_once()
        assert on_result.call_args[0][0].structured_output == {"answer": 42}


# ---------------------------------------------------------------------------
# Invocation message is sent to the transport
# ---------------------------------------------------------------------------


class TestInvocationSent:
    @pytest.mark.asyncio
    async def test_invocation_message_queued(self, fake_transport, make_invocation):
        transport, client = fake_transport([])

        invocation = make_invocation(source_id="capture-test")
        await client.invoke(
            invocation=invocation,
            on_result_message=AsyncMock(),
            result_message_cls=ResultMessageInterface,
        )

        invocation_msgs = [
            m for m in transport.sent if m.get("message_type") == "invocation_message"
        ]
        assert len(invocation_msgs) == 1
        assert invocation_msgs[0]["source_id"] == "capture-test"


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
