"""Advanced LLM integration tests for the OpenAI agent.

Covers pre/post commands, artifact uploads via real S3 presigned URLs,
and the full invocation lifecycle (download -> pre-cmd -> agent -> post-cmd -> upload).
"""

import logging
from uuid import uuid4

import pytest

from test.llm.conftest import wait_for_s3_object

from src.runtimeuse_client import (
    RuntimeUseClient,
    QueryOptions,
    QueryResult,
    TextResult,
    AssistantMessageInterface,
    ArtifactUploadRequestMessageInterface,
    ArtifactUploadResult,
    AgentRuntimeError,
    CommandInterface,
    RuntimeEnvironmentDownloadableInterface,
)

pytestmark = [pytest.mark.llm, pytest.mark.asyncio]

_logger = logging.getLogger(__name__)

MODEL = "gpt-5.1"


class TestOpenAIPrePostCommands:
    async def test_pre_and_post_commands_run(self, openai_ws_url: str):
        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        client = RuntimeUseClient(ws_url=openai_ws_url)
        result = await client.query(
            prompt="Say the word 'acknowledged'",
            options=QueryOptions(
                system_prompt="Reply concisely in plain text.",
                model=MODEL,
                pre_agent_invocation_commands=[
                    CommandInterface(
                        command="echo 'pre-command ran' > /tmp/pre-sentinel.txt && echo pre-sentinel",
                        cwd="/tmp",
                    )
                ],
                post_agent_invocation_commands=[
                    CommandInterface(
                        command="echo 'post-command ran' > /tmp/post-sentinel.txt && echo post-sentinel",
                        cwd="/tmp",
                    )
                ],
                on_assistant_message=on_msg,
                timeout=60,
            ),
        )

        assert isinstance(result, QueryResult)
        assert isinstance(result.data, TextResult)

        all_text = [block for msg in received for block in msg.text_blocks]
        assert any(
            "pre-sentinel" in t for t in all_text
        ), "pre-command output should appear in streamed messages"
        assert any(
            "post-sentinel" in t for t in all_text
        ), "post-command output should appear in streamed messages"

    async def test_failed_pre_command_raises_error(self, openai_ws_url: str):
        client = RuntimeUseClient(ws_url=openai_ws_url)
        with pytest.raises(AgentRuntimeError, match="failed with exit code"):
            await client.query(
                prompt="This prompt should never reach the agent",
                options=QueryOptions(
                    system_prompt="Reply concisely.",
                    model=MODEL,
                    pre_agent_invocation_commands=[CommandInterface(command="exit 1")],
                    timeout=30,
                ),
            )


class TestOpenAIArtifactsS3:
    async def test_artifact_uploaded_to_s3(
        self, openai_ws_url: str, s3_client, s3_test_bucket: str
    ):
        run_id = str(uuid4())
        artifact_key = f"test-artifacts/{run_id}/output.txt"
        artifacts_dir = f"/tmp/test-artifacts-{run_id}"

        async def on_artifact(
            req: ArtifactUploadRequestMessageInterface,
        ) -> ArtifactUploadResult:
            presigned = s3_client.generate_presigned_url(
                "put_object",
                Params={"Bucket": s3_test_bucket, "Key": artifact_key},
                ExpiresIn=300,
            )
            _logger.info(
                "Returning presigned URL for %s: %s",
                req.filename,
                presigned,
            )
            return ArtifactUploadResult(
                presigned_url=presigned,
                content_type="text/plain",
            )

        client = RuntimeUseClient(ws_url=openai_ws_url)
        result = await client.query(
            prompt=(
                f"Create the directory {artifacts_dir} and write a file at "
                f"{artifacts_dir}/output.txt with the exact content "
                "'hello from openai'. Use the bash tool."
            ),
            options=QueryOptions(
                system_prompt="You are a helpful assistant. Execute tasks using tools.",
                model=MODEL,
                artifacts_dir=artifacts_dir,
                on_artifact_upload_request=on_artifact,
                timeout=120,
            ),
        )

        assert isinstance(result.data, TextResult)

        body = wait_for_s3_object(s3_client, s3_test_bucket, artifact_key)
        assert b"hello from openai" in body

        s3_client.delete_object(Bucket=s3_test_bucket, Key=artifact_key)


class TestOpenAIFullLifecycle:
    async def test_full_invocation_ordering(
        self, openai_ws_url: str, s3_client, s3_test_bucket: str
    ):
        run_id = str(uuid4())

        setup_key = f"test-downloads/{run_id}/setup.sh"
        s3_client.put_object(
            Bucket=s3_test_bucket,
            Key=setup_key,
            Body=b"#!/bin/bash\necho setup-payload",
        )
        download_url = s3_client.generate_presigned_url(
            "get_object",
            Params={"Bucket": s3_test_bucket, "Key": setup_key},
            ExpiresIn=300,
        )

        dl_dir = f"/tmp/dl-lifecycle-{run_id}"
        artifacts_dir = f"/tmp/art-lifecycle-{run_id}"
        artifact_key = f"test-artifacts/{run_id}/result.txt"

        received: list[AssistantMessageInterface] = []

        async def on_msg(msg: AssistantMessageInterface):
            received.append(msg)

        async def on_artifact(
            req: ArtifactUploadRequestMessageInterface,
        ) -> ArtifactUploadResult:
            presigned = s3_client.generate_presigned_url(
                "put_object",
                Params={"Bucket": s3_test_bucket, "Key": artifact_key},
                ExpiresIn=300,
            )
            _logger.info(
                "Returning presigned URL for %s: %s",
                req.filename,
                presigned,
            )
            return ArtifactUploadResult(
                presigned_url=presigned,
                content_type="text/plain",
            )

        client = RuntimeUseClient(ws_url=openai_ws_url)
        result = await client.query(
            prompt=(
                f"Create the directory {artifacts_dir} and write a file at "
                f"{artifacts_dir}/result.txt with the content 'lifecycle-result'. "
                "Use the bash tool."
            ),
            options=QueryOptions(
                system_prompt="Execute tasks using available tools. Be concise.",
                model=MODEL,
                pre_agent_downloadables=[
                    RuntimeEnvironmentDownloadableInterface(
                        download_url=download_url,
                        working_dir=dl_dir,
                    )
                ],
                pre_agent_invocation_commands=[
                    CommandInterface(command=f"cat {dl_dir}/setup.sh")
                ],
                post_agent_invocation_commands=[
                    CommandInterface(command="echo lifecycle-done")
                ],
                artifacts_dir=artifacts_dir,
                on_artifact_upload_request=on_artifact,
                on_assistant_message=on_msg,
                timeout=120,
            ),
        )

        assert isinstance(result.data, TextResult)

        all_text = [block for msg in received for block in msg.text_blocks]
        assert any(
            "setup-payload" in t for t in all_text
        ), "pre-command should have cat'd the downloaded file"
        assert any(
            "lifecycle-done" in t for t in all_text
        ), "post-command should have run after the agent"

        body = wait_for_s3_object(s3_client, s3_test_bucket, artifact_key)
        assert b"lifecycle-result" in body

        s3_client.delete_object(Bucket=s3_test_bucket, Key=setup_key)
        s3_client.delete_object(Bucket=s3_test_bucket, Key=artifact_key)
