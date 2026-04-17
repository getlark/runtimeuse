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
  uploadTracker: UploadTracker;
  send: (message: ArtifactUploadRequestMessage) => void;
}

export class ArtifactManager {
  private readonly watcher: ReturnType<typeof chokidar.watch>;
  private readonly pendingRequests = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();
  private readonly watchedDirs = new Map<string, Ignore>();
  private readonly uploadTracker: UploadTracker;
  private readonly send: (message: ArtifactUploadRequestMessage) => void;
  private logger: Logger = defaultLogger;
  private loggingLevel: "info" | "debug" = "info";

  constructor(config: ArtifactManagerConfig) {
    this.uploadTracker = config.uploadTracker;
    this.send = config.send;

    this.watcher = chokidar.watch([], {
      awaitWriteFinish: true,
      alwaysStat: true,
    });

    this.watcher.on("add", (p, s) => this.onFileEvent(p, s));
    this.watcher.on("change", (p, s) => this.onFileEvent(p, s));
  }

  /**
   * Begin watching an artifacts directory. Safe to call repeatedly across
   * requests in the same session — repeat calls for the same directory are
   * no-ops. The watcher stays alive until {@link stopWatching} is called at
   * session close.
   */
  addDirectory(dir: string): void {
    if (this.watchedDirs.has(dir)) return;

    fs.mkdirSync(dir, { recursive: true });

    const ig = ignore();
    const ignorePath = path.join(dir, ".artifactignore");
    if (fs.existsSync(ignorePath)) {
      ig.add(fs.readFileSync(ignorePath, "utf-8"));
      this.logger.log(`Loaded .artifactignore from ${ignorePath}`);
    } else {
      ig.add(DEFAULT_ARTIFACT_IGNORE);
    }

    this.watchedDirs.set(dir, ig);
    this.watcher.add(dir);
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
    this.logger.log("Stopping artifact watcher");
    await this.watcher.close();
  }

  private findOwningDir(filePath: string): string | null {
    for (const dir of this.watchedDirs.keys()) {
      const rel = path.relative(dir, filePath);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        return dir;
      }
    }
    return null;
  }

  private onFileEvent(filePath: string, stats?: fs.Stats): void {
    if (this.loggingLevel === "debug") {
      this.logger.log(
        `Artifact event: ${filePath}. Size: ${stats?.size ?? 0} bytes`,
      );
    }

    if (path.basename(filePath) === ".artifactignore") {
      const owningDir = this.findOwningDir(filePath);
      if (owningDir) this.reloadIgnorePatterns(owningDir);
      return;
    }

    if (!stats?.isFile() || !stats.size) {
      if (this.loggingLevel === "debug") {
        this.logger.debug(`Skipping: ${filePath}`);
      }
      return;
    }

    const owningDir = this.findOwningDir(filePath);
    if (!owningDir) {
      if (this.loggingLevel === "debug") {
        this.logger.debug(`File not in any watched dir: ${filePath}`);
      }
      return;
    }

    const ig = this.watchedDirs.get(owningDir);
    const relativePath = path.relative(owningDir, filePath);
    if (ig && ig.ignores(relativePath)) {
      if (this.loggingLevel === "debug") {
        this.logger.debug(`Skipping ignored artifact: ${relativePath}`);
      }
      return;
    }

    this.requestUpload(filePath);
  }

  private reloadIgnorePatterns(dir: string): void {
    const ig = ignore();
    const ignorePath = path.join(dir, ".artifactignore");
    if (fs.existsSync(ignorePath)) {
      ig.add(fs.readFileSync(ignorePath, "utf-8"));
      this.logger.log(`Reloaded .artifactignore from ${ignorePath}`);
    } else {
      ig.add(DEFAULT_ARTIFACT_IGNORE);
    }
    this.watchedDirs.set(dir, ig);
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
