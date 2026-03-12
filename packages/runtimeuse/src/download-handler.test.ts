import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      createWriteStream: vi.fn(() => ({
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        close: vi.fn(),
      })),
      unlinkSync: vi.fn(),
    },
  };
});

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:stream/promises", () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:stream", () => ({
  Readable: { fromWeb: vi.fn().mockReturnValue("mock-stream") },
}));

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  body: "mock-body",
  status: 200,
  statusText: "OK",
});
vi.stubGlobal("fetch", mockFetch);

import fs from "fs";
import { execFileSync } from "child_process";
import DownloadHandler from "./download-handler.js";
import { pipeline } from "node:stream/promises";
import type { Logger } from "./logger.js";

const mockLogger: Logger = {
  log: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("DownloadHandler", () => {
  let handler: DownloadHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new DownloadHandler(mockLogger);
    mockFetch.mockResolvedValue({
      ok: true,
      body: "mock-body",
      status: 200,
      statusText: "OK",
    });
  });

  describe("directory creation", () => {
    it("creates working directory when it does not exist", async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);

      await handler.download(
        "https://example.com/files/test.tar.gz",
        "/tmp/workdir",
      );

      expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp/workdir", {
        recursive: true,
      });
    });

    it("skips directory creation when working directory exists", async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);

      await handler.download(
        "https://example.com/files/test.tar.gz",
        "/tmp/workdir",
      );

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe("file download", () => {
    it("downloads a file via fetch to the working directory", async () => {
      await handler.download(
        "https://example.com/files/script.sh",
        "/tmp/workdir",
      );

      expect(mockFetch).toHaveBeenCalledWith(
        "https://example.com/files/script.sh",
      );
      expect(pipeline).toHaveBeenCalled();
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        body: null,
      });

      await expect(
        handler.download("https://example.com/files/missing.sh", "/tmp/workdir"),
      ).rejects.toThrow("Download failed: 404 Not Found");
    });

    it("throws when response has no body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        body: null,
      });

      await expect(
        handler.download("https://example.com/files/empty.sh", "/tmp/workdir"),
      ).rejects.toThrow("Download failed: no response body");
    });
  });

  describe("zip handling", () => {
    it("unzips .zip files using execFileSync and removes the archive", async () => {
      await handler.download(
        "https://example.com/files/tests.zip",
        "/tmp/workdir",
      );

      expect(execFileSync).toHaveBeenCalledWith("unzip", [
        "-o",
        "/tmp/workdir/tests.zip",
        "-d",
        "/tmp/workdir",
      ]);
      expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/workdir/tests.zip");
    });

    it("does not unzip non-zip files", async () => {
      await handler.download(
        "https://example.com/files/data.tar.gz",
        "/tmp/workdir",
      );

      expect(execFileSync).not.toHaveBeenCalled();
    });
  });

  describe("logging", () => {
    it("logs the download operation", async () => {
      await handler.download(
        "https://example.com/files/test.sh",
        "/tmp/workdir",
      );

      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining("Downloading file test.sh"),
      );
    });

    it("logs unzip operation for zip files", async () => {
      await handler.download(
        "https://example.com/files/archive.zip",
        "/tmp/workdir",
      );

      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining("Unzipping file archive.zip"),
      );
    });
  });
});
