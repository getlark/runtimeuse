import logging
import os
import time

import pytest

from test.sandbox_factories.e2b import create_e2b_runtimeuse

_logger = logging.getLogger(__name__)


@pytest.fixture(scope="session")
def openai_ws_url():
    """Create an E2B sandbox running runtimeuse with the OpenAI agent."""
    if os.environ.get("USE_LOCAL_WS") == "true":
        yield "ws://localhost:8080"
        return

    try:
        sandbox, ws_url = create_e2b_runtimeuse(agent="openai")
    except RuntimeError as exc:
        pytest.fail(str(exc))

    yield ws_url

    sandbox.kill()


@pytest.fixture(scope="session")
def claude_ws_url():
    """Create an E2B sandbox running runtimeuse with the Claude agent."""
    if os.environ.get("USE_LOCAL_WS") == "true":
        yield "ws://localhost:8080"
        return

    try:
        sandbox, ws_url = create_e2b_runtimeuse(agent="claude")
    except RuntimeError as exc:
        pytest.fail(str(exc))

    yield ws_url

    sandbox.kill()


@pytest.fixture(scope="session")
def s3_client():
    """Boto3 S3 client for artifact upload/download tests."""
    try:
        import boto3
    except ImportError:
        pytest.fail("boto3 is required for S3 tests — install with: pip install boto3")
    return boto3.client("s3")


@pytest.fixture
def s3_test_bucket():
    """Read TEST_S3_BUCKET from env; fail if unset."""
    bucket = os.environ.get("TEST_S3_BUCKET")
    if not bucket:
        pytest.fail("TEST_S3_BUCKET environment variable is not set")
    return bucket


def wait_for_s3_object(
    s3_client,
    bucket: str,
    key: str,
    timeout: float = 30,
    poll_interval: float = 2,
) -> bytes:
    """Poll S3 until the object exists, then return its body.

    The server-side artifact upload may still be in flight when the
    client's query() returns (the presigned-URL PUT races with the
    WebSocket close).  Polling avoids flaky NoSuchKey failures.
    """
    from botocore.exceptions import ClientError

    _logger.info("Waiting for S3 object s3://%s/%s (timeout=%ss)", bucket, key, timeout)
    deadline = time.monotonic() + timeout
    last_exc: Exception | None = None
    attempt = 0

    while time.monotonic() < deadline:
        attempt += 1
        try:
            obj = s3_client.get_object(Bucket=bucket, Key=key)
            _logger.info("S3 object found on attempt %d", attempt)
            return obj["Body"].read()
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "NoSuchKey":
                raise
            elapsed = timeout - (deadline - time.monotonic())
            _logger.info(
                "S3 object not found (attempt %d, %.1fs elapsed), retrying in %ss",
                attempt,
                elapsed,
                poll_interval,
            )
            last_exc = exc
        time.sleep(poll_interval)

    raise AssertionError(
        f"S3 object s3://{bucket}/{key} did not appear within {timeout}s "
        f"after {attempt} attempts"
    ) from last_exc
