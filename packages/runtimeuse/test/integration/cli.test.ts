import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_JS = path.resolve(__dirname, "../../dist/cli.js");
const ECHO_HANDLER = path.resolve(__dirname, "fixtures/echo-handler.js");

const STARTUP_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 100;

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: "127.0.0.1" });
    sock.setTimeout(100);
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(
  port: number,
  timeoutMs = STARTUP_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portIsOpen(port)) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Port ${port} did not open within ${timeoutMs}ms`);
}

function spawnCli(
  args: string[],
  env?: Record<string, string>,
): ChildProcess {
  return spawn("node", [CLI_JS, ...args], {
    env: { ...process.env, NODE_ENV: "test", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function collectOutput(proc: ChildProcess): {
  stdout: () => string;
  stderr: () => string;
} {
  let out = "";
  let err = "";
  proc.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    err += d.toString();
  });
  return { stdout: () => out, stderr: () => err };
}

function waitForExit(proc: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    proc.on("exit", (code) => resolve(code));
  });
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function sendJson(ws: WebSocket, data: unknown): void {
  ws.send(JSON.stringify(data));
}

function collectWsMessages(ws: WebSocket): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = [];
  return new Promise((resolve) => {
    ws.on("message", (raw: Buffer) => {
      messages.push(JSON.parse(raw.toString()));
    });
    ws.on("close", () => resolve(messages));
  });
}

describe("CLI", () => {
  const procs: ChildProcess[] = [];

  function tracked(proc: ChildProcess): ChildProcess {
    procs.push(proc);
    return proc;
  }

  afterEach(() => {
    for (const proc of procs) {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
      }
    }
    procs.length = 0;
  });

  it("--help prints usage and exits 0", async () => {
    const proc = tracked(spawnCli(["--help"]));
    const { stdout } = collectOutput(proc);
    const code = await waitForExit(proc);

    expect(code).toBe(0);
    expect(stdout()).toContain("Usage: runtimeuse");
    expect(stdout()).toContain("--port");
    expect(stdout()).toContain("--handler");
    expect(stdout()).toContain("--agent");
  });

  it("--port binds to the specified port", async () => {
    const port = 9871;
    const proc = tracked(
      spawnCli(["--handler", ECHO_HANDLER, "--port", String(port)]),
    );
    collectOutput(proc);

    await waitForPort(port);

    const ws = await connectWs(port);
    ws.close();
  });

  it("--handler loads a custom handler and responds to invocations", async () => {
    const port = 9872;
    const proc = tracked(
      spawnCli(["--handler", ECHO_HANDLER, "--port", String(port)]),
    );
    collectOutput(proc);

    await waitForPort(port);

    const ws = await connectWs(port);
    const messagesPromise = collectWsMessages(ws);

    sendJson(ws, {
      message_type: "invocation_message",
      system_prompt: "You are a test assistant.",
      user_prompt: "ECHO:hello from cli test",
      secrets_to_redact: [],
      model: "echo",
    });

    const messages = await messagesPromise;
    const result = messages.find(
      (m) => m.message_type === "result_message",
    );

    expect(result).toBeDefined();
    expect(result!.data).toEqual({ type: "text", text: "hello from cli test" });
  });

  it("unknown --agent exits with error", async () => {
    const proc = tracked(spawnCli(["--agent", "bogus"]));
    const { stderr } = collectOutput(proc);
    const code = await waitForExit(proc);

    expect(code).not.toBe(0);
    expect(stderr()).toContain('unknown agent "bogus"');
  });

  it("defaults to openai agent when no --agent is specified", async () => {
    if (!process.env.OPENAI_API_KEY) {
      return; // skip — can't start the openai handler without a key
    }

    const port = 9873;
    const proc = tracked(spawnCli(["--port", String(port)]));
    const { stdout, stderr } = collectOutput(proc);

    await waitForPort(port);

    expect(stderr()).not.toContain("Error");
    expect(stdout()).toContain(`listening on port ${port}`);
  });
});
