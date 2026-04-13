import { describe, it, expect, vi, beforeEach } from "vitest";
import { Writable } from "node:stream";
import type { Logger } from "./logger.js";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
    },
  };
});

let execCallback: Function;
let execChild: any;

vi.mock("node:child_process", () => ({
  exec: vi.fn((_cmd: string, _opts: any, cb: Function) => {
    execCallback = cb;
    execChild = {
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    };
    return execChild;
  }),
}));

import fs from "fs";
import { exec } from "node:child_process";
import CommandHandler from "./command-handler.js";
import type { Command } from "./types.js";

const mockLogger: Logger = {
  log: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function createHandler(
  command: Command,
  abortController = new AbortController(),
  onStdout?: (stdout: string) => void,
  onStderr?: (stderr: string) => void,
  secrets: string[] = [],
) {
  return new CommandHandler({
    command,
    secrets,
    logger: mockLogger,
    abortController,
    onStdout,
    onStderr,
  });
}

describe("CommandHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("directory creation", () => {
    it("creates cwd directory when it does not exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);
      const handler = createHandler({ command: "echo", cwd: "/tmp/test-dir" });

      const promise = handler.execute();

      execCallback(null, "ok", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(0);

      await promise;

      expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp/test-dir", {
        recursive: true,
      });
    });

    it("does not create cwd directory when it already exists", async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      const handler = createHandler({ command: "echo", cwd: "/tmp/existing" });

      const promise = handler.execute();

      execCallback(null, "", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(0);

      await promise;

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it("skips directory creation when cwd is not specified", async () => {
      const handler = createHandler({ command: "echo" });

      const promise = handler.execute();

      execCallback(null, "", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(0);

      await promise;

      expect(fs.existsSync).not.toHaveBeenCalled();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe("command execution", () => {
    it("calls exec with the right command and cwd", () => {
      const handler = createHandler({
        command: "ls",
        cwd: "/work",
      });

      handler.execute();

      expect(exec).toHaveBeenCalledWith(
        "ls",
        expect.objectContaining({
          cwd: "/work",
        }),
        expect.any(Function),
      );
    });

    it("uses process.cwd() when cwd is not specified", () => {
      const handler = createHandler({ command: "pwd" });

      handler.execute();

      expect(exec).toHaveBeenCalledWith(
        "pwd",
        expect.objectContaining({ cwd: process.cwd() }),
        expect.any(Function),
      );
    });

    it("merges command env on top of process.env", () => {
      const handler = createHandler({
        command: "echo",
        cwd: "/work",
        env: { MY_VAR: "hello", OTHER: "world" },
      });

      handler.execute();

      expect(exec).toHaveBeenCalledWith(
        "echo",
        expect.objectContaining({
          env: { ...process.env, MY_VAR: "hello", OTHER: "world" },
        }),
        expect.any(Function),
      );
    });

    it("uses only process.env when command env is undefined", () => {
      const handler = createHandler({ command: "echo", cwd: "/work" });

      handler.execute();

      expect(exec).toHaveBeenCalledWith(
        "echo",
        expect.objectContaining({
          env: { ...process.env },
        }),
        expect.any(Function),
      );
    });

    it("passes abort signal to exec", () => {
      const ac = new AbortController();
      const handler = createHandler({ command: "sleep" }, ac);

      handler.execute();

      expect(exec).toHaveBeenCalledWith(
        "sleep",
        expect.objectContaining({ signal: ac.signal }),
        expect.any(Function),
      );
    });
  });

  describe("exit handling", () => {
    it("resolves with exitCode 0 on successful close", async () => {
      const handler = createHandler({ command: "true" });

      const promise = handler.execute();

      execCallback(null, "output", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(0);

      const result = await promise;
      expect(result).toEqual({ exitCode: 0 });
    });

    it("resolves with exitCode 1 on close with code 1", async () => {
      const handler = createHandler({ command: "false" });

      const promise = handler.execute();

      execCallback(null, "", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(1);

      const result = await promise;
      expect(result).toEqual({ exitCode: 1 });
    });

    it("resolves with exitCode 1 and error when callback reports code 1", async () => {
      const handler = createHandler({ command: "failing" });

      const promise = handler.execute();

      const err = Object.assign(new Error("exit 1"), { code: 1 });
      execCallback(err, "", "some error");

      const result = await promise;
      expect(result.exitCode).toBe(1);
      expect(result.error).toBeDefined();
    });

    it("rejects with non-0/1 exit codes from close event", async () => {
      const handler = createHandler({ command: "segfault" });

      const promise = handler.execute();

      execCallback(null, "", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(139);

      await expect(promise).rejects.toEqual({ exitCode: 139 });
    });

    it("rejects when callback reports a non-1 error code", async () => {
      const handler = createHandler({ command: "crash" });

      const promise = handler.execute();

      const err = Object.assign(new Error("killed"), { code: 137 });
      execCallback(err, "", "");

      await expect(promise).rejects.toMatchObject({ exitCode: 137 });
    });
  });

  describe("stream output", () => {
    it("writes stdout to the stdout stream", async () => {
      const onStdout = vi.fn();
      const handler = createHandler(
        { command: "echo" },
        new AbortController(),
        onStdout,
      );

      const promise = handler.execute();

      const stdoutDataHandler = execChild.stdout.on.mock.calls.find(
        (c: unknown[]) => c[0] === "data",
      )[1];
      stdoutDataHandler("hello world");

      execCallback(null, "", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(0);

      await promise;
      expect(onStdout).toHaveBeenCalledWith("hello world");
    });

    it("writes stderr to the stderr stream", async () => {
      const onStderr = vi.fn();
      const handler = createHandler(
        { command: "warn" },
        new AbortController(),
        undefined,
        onStderr,
      );

      const promise = handler.execute();

      const stderrDataHandler = execChild.stderr.on.mock.calls.find(
        (c: unknown[]) => c[0] === "data",
      )[1];
      stderrDataHandler("warning message");

      execCallback(null, "", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(0);

      await promise;
      expect(onStderr).toHaveBeenCalledWith("warning message");
    });

    it("redacts secrets from stdout", async () => {
      const onStdout = vi.fn();
      const handler = createHandler(
        { command: "echo" },
        new AbortController(),
        onStdout,
        undefined,
        ["s3cret"],
      );

      const promise = handler.execute();

      const stdoutDataHandler = execChild.stdout.on.mock.calls.find(
        (c: unknown[]) => c[0] === "data",
      )[1];
      stdoutDataHandler("token is s3cret ok");

      execCallback(null, "", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(0);

      await promise;
      expect(onStdout).toHaveBeenCalledWith("token is [REDACTED] ok");
    });

    it("redacts secrets from stderr", async () => {
      const onStderr = vi.fn();
      const handler = createHandler(
        { command: "warn" },
        new AbortController(),
        undefined,
        onStderr,
        ["hunter2"],
      );

      const promise = handler.execute();

      const stderrDataHandler = execChild.stderr.on.mock.calls.find(
        (c: unknown[]) => c[0] === "data",
      )[1];
      stderrDataHandler("error: hunter2 leaked");

      execCallback(null, "", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(0);

      await promise;
      expect(onStderr).toHaveBeenCalledWith("error: [REDACTED] leaked");
    });

    it("redacts multiple secrets from output", async () => {
      const onStdout = vi.fn();
      const handler = createHandler(
        { command: "echo" },
        new AbortController(),
        onStdout,
        undefined,
        ["aaa", "bbb"],
      );

      const promise = handler.execute();

      const stdoutDataHandler = execChild.stdout.on.mock.calls.find(
        (c: unknown[]) => c[0] === "data",
      )[1];
      stdoutDataHandler("aaa and bbb");

      execCallback(null, "", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(0);

      await promise;
      expect(onStdout).toHaveBeenCalledWith("[REDACTED] and [REDACTED]");
    });

    it("passes redacted data to onStdout callback", async () => {
      const onStdout = vi.fn();
      const handler = new CommandHandler({
        command: { command: "echo" },
        secrets: ["xyz"],
        logger: mockLogger,
        abortController: new AbortController(),
        onStdout: onStdout,
      });

      const promise = handler.execute();

      const stdoutDataHandler = execChild.stdout.on.mock.calls.find(
        (c: unknown[]) => c[0] === "data",
      )[1];
      stdoutDataHandler("value=xyz");

      execCallback(null, "", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(0);

      await promise;
      expect(onStdout).toHaveBeenCalledWith("value=[REDACTED]");
    });

    it("does not redact when no secrets provided", async () => {
      const onStdout = vi.fn();
      const handler = createHandler(
        { command: "echo" },
        new AbortController(),
        onStdout,
      );

      const promise = handler.execute();

      const stdoutDataHandler = execChild.stdout.on.mock.calls.find(
        (c: unknown[]) => c[0] === "data",
      )[1];
      stdoutDataHandler("nothing secret here");

      execCallback(null, "", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(0);

      await promise;
      expect(onStdout).toHaveBeenCalledWith("nothing secret here");
    });

    it("does not write empty stdout", async () => {
      const onStdout = vi.fn();
      const handler = createHandler(
        { command: "silent" },
        new AbortController(),
        onStdout,
      );

      const promise = handler.execute();

      execCallback(null, "", "");
      const closeHandler = execChild.on.mock.calls.find(
        (c: unknown[]) => c[0] === "close",
      )[1];
      closeHandler(0);

      await promise;
      expect(onStdout).not.toHaveBeenCalled();
    });
  });
});
