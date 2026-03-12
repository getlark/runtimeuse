import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWatcher = {
  on: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
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
  type ArtifactManagerConfig,
} from "./artifact-manager.js";
import { UploadTracker } from "./upload-tracker.js";
import { uploadFile } from "./storage.js";

function createManager(overrides: Partial<ArtifactManagerConfig> = {}) {
  const send = vi.fn();
  const uploadTracker = new UploadTracker();
  const config: ArtifactManagerConfig = {
    artifactsDir: "/tmp/artifacts",
    uploadTracker,
    send,
    ...overrides,
  };
  const manager = new ArtifactManager(config);
  return { manager, send, uploadTracker };
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
    it("creates a chokidar watcher on the artifacts directory", () => {
      createManager();
      expect(chokidar.watch).toHaveBeenCalledWith("/tmp/artifacts", {
        awaitWriteFinish: true,
        alwaysStat: true,
      });
    });

    it("registers add and change handlers", () => {
      createManager();
      const events = mockWatcher.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(events).toContain("add");
      expect(events).toContain("change");
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
});
