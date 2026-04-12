import asyncio
import os
import signal
import socket
import subprocess
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

import pytest

from src.runtimeuse_client import RuntimeUseClient, QueryOptions, ExecuteCommandsOptions

E2E_PORT = 8089
REPO_ROOT = Path(__file__).resolve().parents[4]
CLI_JS = REPO_ROOT / "packages" / "runtimeuse" / "dist" / "cli.js"
HANDLER_JS = Path(__file__).resolve().parent / "echo_handler.js"

STARTUP_TIMEOUT_S = 10
POLL_INTERVAL_S = 0.15


def _port_is_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.1)
        return s.connect_ex(("127.0.0.1", port)) == 0


@pytest.fixture
def ws_url():
    """Start a local runtimeuse server with the echo handler and yield its URL."""
    if not CLI_JS.exists():
        pytest.fail(
            f"runtimeuse CLI not found at {CLI_JS}. "
            "Run 'npm run build' in packages/runtimeuse first."
        )

    proc = subprocess.Popen(
        ["node", str(CLI_JS), "--handler", str(HANDLER_JS), "--port", str(E2E_PORT)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env={**os.environ, "NODE_ENV": "test"},
    )

    deadline = time.monotonic() + STARTUP_TIMEOUT_S
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            output = proc.stdout.read().decode() if proc.stdout else ""
            pytest.fail(
                f"runtimeuse server exited early (code {proc.returncode}):\n{output}"
            )
        if _port_is_open(E2E_PORT):
            break
        time.sleep(POLL_INTERVAL_S)
    else:
        proc.kill()
        pytest.fail(f"runtimeuse server did not start within {STARTUP_TIMEOUT_S}s")

    yield f"ws://127.0.0.1:{E2E_PORT}"

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture
def client(ws_url: str) -> RuntimeUseClient:
    return RuntimeUseClient(ws_url=ws_url)


def _make_query_options(**overrides: Any) -> QueryOptions:
    defaults: dict[str, Any] = {
        "system_prompt": "You are a test assistant.",
        "model": "echo",
    }
    defaults.update(overrides)
    return QueryOptions(**defaults)


@pytest.fixture
def query_options() -> QueryOptions:
    return _make_query_options()


@pytest.fixture
def make_query_options():
    return _make_query_options


def _make_execute_commands_options(**overrides: Any) -> ExecuteCommandsOptions:
    return ExecuteCommandsOptions(**overrides)


@pytest.fixture
def make_execute_commands_options():
    return _make_execute_commands_options


@pytest.fixture
def http_server():
    """Local HTTP server for serving downloadable files and receiving artifact uploads.

    Yields (base_url, files, uploads) where:
      - files: dict[str, bytes]  — seed with content before the test runs a query
      - uploads: dict[str, bytes] — populated by PUT requests during the test
    """
    uploads: dict[str, bytes] = {}
    files: dict[str, bytes] = {}

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path.startswith("/files/"):
                name = self.path[len("/files/"):]
                if name in files:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.end_headers()
                    self.wfile.write(files[name])
                    return
            self.send_response(404)
            self.end_headers()

        def do_PUT(self) -> None:
            if self.path.startswith("/uploads/"):
                name = self.path[len("/uploads/"):]
                length = int(self.headers.get("Content-Length", 0))
                uploads[name] = self.rfile.read(length)
                self.send_response(200)
                self.end_headers()
                return
            self.send_response(404)
            self.end_headers()

        def log_message(self, format: str, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), _Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    yield f"http://127.0.0.1:{port}", files, uploads

    server.shutdown()
