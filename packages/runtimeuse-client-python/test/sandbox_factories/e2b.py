"""Factory for creating E2B sandboxes running a runtimeuse server."""

from __future__ import annotations

import logging
import os

from e2b import Template, wait_for_port, default_build_logger
from e2b_code_interpreter import Sandbox

_logger = logging.getLogger(__name__)

_DEFAULT_RUN_COMMAND = "npx -y runtimeuse@latest"


def _get_env_or_fail(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} environment variable is not set")
    return value


def _should_try_reuse() -> bool:
    """Return True when E2B_REUSE_TEMPLATE is set to a truthy value."""
    return os.environ.get("E2B_REUSE_TEMPLATE", "").lower() in ("1", "true", "yes")


def create_e2b_runtimeuse(
    agent: str = "openai",
    run_command: str | None = None,
) -> tuple[Sandbox, str]:
    """Build an E2B template, create a sandbox, and return ``(sandbox, ws_url)``.

    When ``E2B_REUSE_TEMPLATE=1`` is set, the factory first tries to create a
    sandbox from the existing template.  If the template does not exist yet it
    falls back to building it.  When the env var is unset or falsy the template
    is always rebuilt so it reflects the current ``RUNTIMEUSE_RUN_COMMAND`` and
    env vars.

    The caller owns the returned sandbox and must call ``sandbox.kill()``
    when done.
    """
    e2b_api_key = _get_env_or_fail("E2B_API_KEY")
    cmd = run_command or os.environ.get("RUNTIMEUSE_RUN_COMMAND", _DEFAULT_RUN_COMMAND)

    envs: dict[str, str] = {}
    if agent == "openai":
        envs["OPENAI_API_KEY"] = _get_env_or_fail("OPENAI_API_KEY")
    elif agent == "claude":
        envs["ANTHROPIC_API_KEY"] = _get_env_or_fail("ANTHROPIC_API_KEY")

    alias = f"runtimeuse-test-{agent}"
    start_cmd = f"{cmd} --agent {agent}"

    need_build = True

    if _should_try_reuse():
        _logger.info("Trying to reuse existing E2B template %r", alias)
        try:
            sandbox = Sandbox.create(template=alias, api_key=e2b_api_key)
            need_build = False
        except Exception:
            _logger.info("Template %r not found, will build it", alias)

    if need_build:
        _logger.info("Building E2B template %r with command: %s", alias, start_cmd)

        template = (
            Template()
            .from_node_image("lts")
            .apt_install(["unzip", "openssh-server"])
            .npm_install(["@anthropic-ai/claude-code"], g=True)
            .run_cmd(
                [
                    "curl -fsSL -o /usr/local/bin/websocat https://github.com/vi/websocat/releases/latest/download/websocat.x86_64-unknown-linux-musl",
                    "chmod a+x /usr/local/bin/websocat",
                ],
                user="root",
            )
            .set_envs(envs)
            .set_start_cmd(start_cmd, wait_for_port(8080))
        )

        Template.build(
            template,
            alias,
            cpu_count=2,
            memory_mb=2048,
            on_build_logs=default_build_logger(),
        )

        sandbox = Sandbox.create(template=alias, api_key=e2b_api_key)

    # start ssh server in the background
    sandbox.commands.run(
        "sudo websocat -b --exit-on-eof ws-l:0.0.0.0:8081 tcp:127.0.0.1:22",
        background=True,
        timeout=0,
    )
    host = sandbox.get_host(8081)
    _logger.info(
        f"SSH server connection string: ssh -o 'ProxyCommand=websocat --binary -B 65536 - wss://8081-%h.e2b.app' user@{sandbox.sandbox_id}"
    )

    host = sandbox.get_host(8080)
    ws_url = f"wss://{host}"

    _logger.info("Sandbox %s ready at %s", sandbox.sandbox_id, ws_url)

    return sandbox, ws_url
