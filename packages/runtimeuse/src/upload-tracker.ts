import { defaultLogger, type Logger } from "./logger.js";

export class UploadTracker {
  private readonly pending = new Set<Promise<any>>();
  private logger: Logger = defaultLogger;

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  track(promise: Promise<any>): void {
    this.pending.add(promise);
    promise
      .catch((error) => this.logger.error("Error uploading artifact:", error))
      .finally(() => this.pending.delete(promise));
  }

  async waitForAll(timeoutMs: number): Promise<void> {
    if (this.pending.size === 0) return;
    this.logger.log(`Waiting for ${this.pending.size} uploads...`);
    await Promise.race([
      Promise.allSettled(this.pending),
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ]);
  }

  get size(): number {
    return this.pending.size;
  }
}
