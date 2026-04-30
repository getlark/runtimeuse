import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWatcher = {
  on: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
  add: vi.fn(),
};

vi.mock("chokidar", () => ({
  default: { watch: vi.fn(() => mockWatcher) },
}));

vi.mock("./storage.js", () => ({
  uploadFile: vi.fn().mockResolvedValue(true),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ""),
      createWriteStream: vi.fn(),
    },
  };
});

import fs from "fs";
import chokidar from "chokidar";
import {
  ArtifactManager,
  type AddDirectoryOptions,
  type ArtifactManagerConfig,
} from "./artifact-manager.js";
import { UploadTracker } from "./upload-tracker.js";
import { uploadFile } from "./storage.js";
import type { Logger } from "./logger.js";

function makeLogger(): Logger {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createManager(
  overrides: Partial<ArtifactManagerConfig> = {},
  artifactsDir: string | null = "/tmp/artifacts",
  addOptions: AddDirectoryOptions = {},
) {
  const send = vi.fn();
  const uploadTracker = new UploadTracker();
  const config: ArtifactManagerConfig = {
    uploadTracker,
    send,
    ...overrides,
  };
  const logger = makeLogger();
  const manager = new ArtifactManager(config);
  manager.setLogger(logger);
  if (artifactsDir) manager.addDirectory(artifactsDir, addOptions);
  return { manager, send, uploadTracker, logger };
}

function getHandler(event: string) {
  const call = mockWatcher.on.mock.calls.find((c: unknown[]) => c[0] === event);
  if (!call) throw new Error(`No handler for "${event}"`);
  return call[1] as (path: string, stats?: any) => void;
}

const fileStats = (size = 1024) => ({ isFile: () => true, size });
const dirStats = () => ({ isFile: () => false, size: 4096 });

describe("ArtifactManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWatcher.on.mockReturnThis();
    mockWatcher.close.mockResolvedValue(undefined);
  });

  describe("constructor", () => {
    it("creates an empty chokidar watcher and registers dirs later", () => {
      createManager();
      expect(chokidar.watch).toHaveBeenCalledWith([], {
        awaitWriteFinish: true,
        alwaysStat: true,
      });
      expect(mockWatcher.add).toHaveBeenCalledWith("/tmp/artifacts");
    });

    it("registers add and change handlers", () => {
      createManager();
      const events = mockWatcher.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(events).toContain("add");
      expect(events).toContain("change");
    });

    it("supports multiple directories in one session", () => {
      const { manager } = createManager({}, null);
      manager.addDirectory("/tmp/run-one");
      manager.addDirectory("/tmp/run-two");
      expect(mockWatcher.add).toHaveBeenCalledWith("/tmp/run-one");
      expect(mockWatcher.add).toHaveBeenCalledWith("/tmp/run-two");
    });

    it("ignores repeat addDirectory calls for the same path", () => {
      const { manager } = createManager({}, null);
      manager.addDirectory("/tmp/run-one");
      manager.addDirectory("/tmp/run-one");
      expect(
        mockWatcher.add.mock.calls.filter((c) => c[0] === "/tmp/run-one"),
      ).toHaveLength(1);
    });
  });

  describe("file event handling", () => {
    it("sends upload request for a new file", () => {
      const { send } = createManager();
      getHandler("add")("/tmp/artifacts/screenshot.png", fileStats());

      expect(send).toHaveBeenCalledWith({
        message_type: "artifact_upload_request_message",
        filename: "screenshot.png",
        filepath: "/tmp/artifacts/screenshot.png",
      });
    });

    it("sends upload request for a changed file", () => {
      const { send } = createManager();
      getHandler("change")("/tmp/artifacts/video.webm", fileStats());

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: "video.webm",
          filepath: "/tmp/artifacts/video.webm",
        }),
      );
    });

    it("skips directories", () => {
      const { send } = createManager();
      getHandler("add")("/tmp/artifacts/subdir", dirStats());
      expect(send).not.toHaveBeenCalled();
    });

    it("skips empty files", () => {
      const { send } = createManager();
      getHandler("add")("/tmp/artifacts/empty.png", fileStats(0));
      expect(send).not.toHaveBeenCalled();
    });

    it("skips files with no stats", () => {
      const { send } = createManager();
      getHandler("add")("/tmp/artifacts/mystery.png", undefined);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("handleUploadResponse", () => {
    it("uploads the file via presigned URL", async () => {
      const { manager } = createManager();
      getHandler("add")("/tmp/artifacts/shot.png", fileStats());

      await manager.handleUploadResponse({
        message_type: "artifact_upload_response_message",
        filename: "shot.png",
        filepath: "/tmp/artifacts/shot.png",
        presigned_url: "https://s3.example.com/upload",
        content_type: "image/png",
      });

      expect(uploadFile).toHaveBeenCalledWith(
        "/tmp/artifacts/shot.png",
        "https://s3.example.com/upload",
        "image/png",
        expect.any(Object),
      );
    });

    it("resolves the pending request after upload", async () => {
      const { manager } = createManager();
      getHandler("add")("/tmp/artifacts/shot.png", fileStats());

      const waitPromise = manager.waitForPendingRequests(5000);

      await manager.handleUploadResponse({
        message_type: "artifact_upload_response_message",
        filename: "shot.png",
        filepath: "/tmp/artifacts/shot.png",
        presigned_url: "https://s3.example.com/upload",
        content_type: "image/png",
      });

      await waitPromise;
    });

    it("swallows ENOENT errors", async () => {
      const enoent = new Error("File not found");
      enoent.name = "ENOENT";
      vi.mocked(uploadFile).mockRejectedValueOnce(enoent);

      const { manager } = createManager();
      getHandler("add")("/tmp/artifacts/gone.png", fileStats());

      await expect(
        manager.handleUploadResponse({
          message_type: "artifact_upload_response_message",
          filename: "gone.png",
          filepath: "/tmp/artifacts/gone.png",
          presigned_url: "https://s3.example.com/upload",
          content_type: "image/png",
        }),
      ).resolves.toBeUndefined();
    });

    it("rethrows non-ENOENT errors", async () => {
      vi.mocked(uploadFile).mockRejectedValueOnce(new Error("network error"));

      const { manager } = createManager();
      getHandler("add")("/tmp/artifacts/shot.png", fileStats());

      await expect(
        manager.handleUploadResponse({
          message_type: "artifact_upload_response_message",
          filename: "shot.png",
          filepath: "/tmp/artifacts/shot.png",
          presigned_url: "https://s3.example.com/upload",
          content_type: "image/png",
        }),
      ).rejects.toThrow("network error");
    });
  });

  describe("waitForPendingRequests", () => {
    it("resolves immediately when no pending requests", async () => {
      const { manager } = createManager();
      await manager.waitForPendingRequests(1000);
    });

    it("times out if requests are not completed", async () => {
      const { manager } = createManager();
      getHandler("add")("/tmp/artifacts/shot.png", fileStats());

      const start = Date.now();
      await manager.waitForPendingRequests(50);
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });
  });

  describe("stopWatching", () => {
    it("closes the chokidar watcher", async () => {
      const { manager } = createManager();
      await manager.stopWatching();
      expect(mockWatcher.close).toHaveBeenCalled();
    });
  });

  describe(".artifactignore", () => {
    it("skips files matching .artifactignore patterns", () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockReturnValueOnce("*.log\ntmp/\n");

      const { send } = createManager();
      getHandler("add")("/tmp/artifacts/debug.log", fileStats());
      expect(send).not.toHaveBeenCalled();
    });

    it("skips files in ignored directories", () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockReturnValueOnce("tmp/\n");

      const { send } = createManager();
      getHandler("add")("/tmp/artifacts/tmp/output.png", fileStats());
      expect(send).not.toHaveBeenCalled();
    });

    it("allows files not matching .artifactignore patterns", () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockReturnValueOnce("*.log\n");

      const { send } = createManager();
      getHandler("add")("/tmp/artifacts/screenshot.png", fileStats());
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ filename: "screenshot.png" }),
      );
    });

    it("uploads all files when no .artifactignore exists", () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);

      const { send } = createManager();
      getHandler("add")("/tmp/artifacts/debug.log", fileStats());
      expect(send).toHaveBeenCalled();
    });

    it("reloads patterns when .artifactignore is added at runtime", () => {
      const { send } = createManager();

      getHandler("add")("/tmp/artifacts/debug.log", fileStats());
      expect(send).toHaveBeenCalledTimes(1);

      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockReturnValueOnce("*.log\n");
      getHandler("add")("/tmp/artifacts/.artifactignore", fileStats());

      send.mockClear();
      getHandler("add")("/tmp/artifacts/debug.log", fileStats());
      expect(send).not.toHaveBeenCalled();
    });

    it("reloads patterns when .artifactignore is modified at runtime", () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockReturnValueOnce("*.log\n");
      const { send } = createManager();

      getHandler("add")("/tmp/artifacts/screenshot.png", fileStats());
      expect(send).toHaveBeenCalledTimes(1);

      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockReturnValueOnce("*.log\n*.png\n");
      getHandler("change")("/tmp/artifacts/.artifactignore", fileStats());

      send.mockClear();
      getHandler("add")("/tmp/artifacts/screenshot.png", fileStats());
      expect(send).not.toHaveBeenCalled();
    });

    it("does not upload the .artifactignore file itself", () => {
      const { send } = createManager();
      getHandler("add")("/tmp/artifacts/.artifactignore", fileStats());
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("ignoreContent option", () => {
    it("applies inline ignore patterns from ignoreContent", () => {
      const { send } = createManager({}, "/tmp/artifacts", {
        ignoreContent: "*.log\n",
      });
      getHandler("add")("/tmp/artifacts/debug.log", fileStats());
      expect(send).not.toHaveBeenCalled();
    });

    it("does not read .artifactignore from disk when ignoreContent is provided", () => {
      createManager({}, "/tmp/artifacts", { ignoreContent: "*.log\n" });
      expect(fs.existsSync).not.toHaveBeenCalled();
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it("ignoreContent wins over an inline blob even with a .artifactignore on disk", () => {
      const { send } = createManager({}, "/tmp/artifacts", {
        ignoreContent: "*.log\n",
      });

      // The inline blob declares only *.log, so a file matching the on-disk
      // .artifactignore (*.png) should still be uploaded.
      getHandler("add")("/tmp/artifacts/screenshot.png", fileStats());
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ filename: "screenshot.png" }),
      );

      send.mockClear();
      // *.log SHOULD be ignored per the inline blob.
      getHandler("add")("/tmp/artifacts/debug.log", fileStats());
      expect(send).not.toHaveBeenCalled();

      // The inline blob path must not touch the filesystem at all.
      expect(fs.existsSync).not.toHaveBeenCalled();
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it("file event for .artifactignore does not overwrite the inline blob", () => {
      const { send } = createManager({}, "/tmp/artifacts", {
        ignoreContent: "*.log\n",
      });

      // A .artifactignore file event would, without the pin, replace the
      // patterns with whatever the file contains. The pin should short-circuit
      // before the runtime even checks the filesystem.
      getHandler("change")(
        "/tmp/artifacts/.artifactignore",
        fileStats(),
      );

      // The inline blob is still in effect, so *.log is still ignored.
      getHandler("add")("/tmp/artifacts/debug.log", fileStats());
      expect(send).not.toHaveBeenCalled();
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it("warns when neither ignoreContent nor a .artifactignore file is provided", () => {
      const { logger } = createManager();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "No artifact ignore patterns provided for /tmp/artifacts",
        ),
      );
    });

    it("does not warn when an .artifactignore file is found", () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockReturnValueOnce("*.log\n");
      const { logger } = createManager();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("does not warn when ignoreContent is provided", () => {
      const { logger } = createManager({}, "/tmp/artifacts", {
        ignoreContent: "*.log\n",
      });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("treats ignoreContent: null the same as omitted", () => {
      // The session forwards `message.artifacts_ignore_content` straight into
      // options, and Python clients serialize unset optional fields as JSON
      // null. The manager must not pass that null into the ignore parser.
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockReturnValueOnce("*.log\n");

      const { send } = createManager({}, "/tmp/artifacts", {
        ignoreContent: null as unknown as string | undefined,
      });
      // Falls back to the on-disk .artifactignore loaded above.
      getHandler("add")("/tmp/artifacts/debug.log", fileStats());
      expect(send).not.toHaveBeenCalled();
    });
  });
});
