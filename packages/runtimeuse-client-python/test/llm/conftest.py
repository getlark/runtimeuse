import pytest

from test.sandbox_factories.e2b import create_e2b_runtimeuse


@pytest.fixture(scope="session")
def openai_ws_url():
    """Create an E2B sandbox running runtimeuse with the OpenAI agent."""
    try:
        sandbox, ws_url = create_e2b_runtimeuse(agent="openai")
    except RuntimeError as exc:
        pytest.fail(str(exc))

    yield ws_url

    sandbox.kill()


@pytest.fixture(scope="session")
def claude_ws_url():
    """Create an E2B sandbox running runtimeuse with the Claude agent."""
    try:
        sandbox, ws_url = create_e2b_runtimeuse(agent="claude")
    except RuntimeError as exc:
        pytest.fail(str(exc))

    yield ws_url

    sandbox.kill()
