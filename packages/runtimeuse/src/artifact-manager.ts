import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import ignore, { type Ignore } from "ignore";
import { uploadFile } from "./storage.js";
import type { UploadTracker } from "./upload-tracker.js";
import type {
  ArtifactUploadRequestMessage,
  ArtifactUploadResponseMessage,
} from "./types.js";
import { DEFAULT_ARTIFACT_IGNORE } from "./constants.js";
import { defaultLogger, type Logger } from "./logger.js";

export interface ArtifactManagerConfig {
  artifactsDir: string;
  uploadTracker: UploadTracker;
  send: (message: ArtifactUploadRequestMessage) => void;
}

export class ArtifactManager {
  private readonly watcher: ReturnType<typeof chokidar.watch>;
  private readonly pendingRequests = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();
  private readonly artifactsDir: string;
  private readonly uploadTracker: UploadTracker;
  private readonly send: (message: ArtifactUploadRequestMessage) => void;
  private ig: Ignore = ignore();
  private logger: Logger = defaultLogger;
  private loggingLevel: "info" | "debug" = "info";

  constructor(config: ArtifactManagerConfig) {
    this.artifactsDir = config.artifactsDir;
    this.uploadTracker = config.uploadTracker;
    this.send = config.send;

    this.reloadIgnorePatterns();

    this.watcher = chokidar.watch(config.artifactsDir, {
      awaitWriteFinish: true,
      alwaysStat: true,
    });

    this.watcher.on("add", (p, s) => this.onFileEvent(p, s));
    this.watcher.on("change", (p, s) => this.onFileEvent(p, s));
  }

  private reloadIgnorePatterns(): void {
    this.ig = ignore();
    const ignorePath = path.join(this.artifactsDir, ".artifactignore");
    if (fs.existsSync(ignorePath)) {
      this.ig.add(fs.readFileSync(ignorePath, "utf-8"));
      this.logger.log(`Loaded .artifactignore from ${ignorePath}`);
    } else {
      this.ig.add(DEFAULT_ARTIFACT_IGNORE);
    }
  }

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  async handleUploadResponse(
    message: ArtifactUploadResponseMessage,
  ): Promise<void> {
    this.logger.log(
      `Uploading artifact: ${message.filename} ${message.filepath}`,
    );

    const promise = uploadFile(
      message.filepath,
      message.presigned_url,
      message.content_type,
      this.logger,
    );
    this.uploadTracker.track(promise);

    try {
      await promise;
    } catch (error) {
      if (error instanceof Error && error.name === "ENOENT") {
        this.logger.log(`Artifact file not found: ${message.filepath}`);
        return;
      }
      throw error;
    }

    const pending = this.pendingRequests.get(message.filename);
    if (pending) {
      pending.resolve();
      this.pendingRequests.delete(message.filename);
    }
  }

  async waitForPendingRequests(timeoutMs: number): Promise<void> {
    const promises = [...this.pendingRequests.values()].map((r) => r.promise);
    if (promises.length === 0) return;
    this.logger.log(`Waiting for ${promises.length} artifact round-trips...`);
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ]);
  }

  async stopWatching(): Promise<void> {
    await this.watcher.close();
  }

  private onFileEvent(filePath: string, stats?: fs.Stats): void {
    if (this.loggingLevel === "debug") {
      this.logger.log(
        `Artifact event: ${filePath}. Size: ${stats?.size ?? 0} bytes`,
      );
    }

    if (path.basename(filePath) === ".artifactignore") {
      this.reloadIgnorePatterns();
      return;
    }

    if (!stats?.isFile() || !stats.size) {
      if (this.loggingLevel === "debug") {
        this.logger.debug(`Skipping: ${filePath}`);
      }
      return;
    }

    const relativePath = path.relative(this.artifactsDir, filePath);
    if (!relativePath.startsWith("..") && this.ig.ignores(relativePath)) {
      if (this.loggingLevel === "debug") {
        this.logger.debug(`Skipping ignored artifact: ${relativePath}`);
      }
      return;
    }

    this.requestUpload(filePath);
  }

  private requestUpload(filePath: string): void {
    const filename = path.basename(filePath);

    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.pendingRequests.set(filename, { promise, resolve });

    this.logger.log(`Requesting upload for artifact: ${filename}`);
    this.send({
      message_type: "artifact_upload_request_message",
      filename,
      filepath: filePath,
    });
  }
}
