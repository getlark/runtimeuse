import { describe, it, expect, vi, beforeEach } from "vitest";
import { UploadTracker } from "./upload-tracker.js";

describe("UploadTracker", () => {
  let tracker: UploadTracker;

  beforeEach(() => {
    tracker = new UploadTracker();
  });

  it("starts with size 0", () => {
    expect(tracker.size).toBe(0);
  });

  it("tracks a pending upload", () => {
    tracker.track(new Promise(() => {}));
    expect(tracker.size).toBe(1);
  });

  it("tracks multiple pending uploads", () => {
    tracker.track(new Promise(() => {}));
    tracker.track(new Promise(() => {}));
    tracker.track(new Promise(() => {}));
    expect(tracker.size).toBe(3);
  });

  it("removes upload after it resolves", async () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    tracker.track(promise);
    expect(tracker.size).toBe(1);

    resolve();
    await promise;
    await flushMicrotasks();
    expect(tracker.size).toBe(0);
  });

  it("removes upload after it rejects", async () => {
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((_, r) => {
      reject = r;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    tracker.track(promise);
    expect(tracker.size).toBe(1);

    reject(new Error("fail"));
    await flushMicrotasks();
    expect(tracker.size).toBe(0);
  });

  it("logs error when a tracked upload rejects", async () => {
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    let reject!: (e: Error) => void;
    const promise = new Promise<void>((_, r) => {
      reject = r;
    });
    tracker.track(promise);

    const error = new Error("upload failed");
    reject(error);
    await flushMicrotasks();

    expect(consoleSpy).toHaveBeenCalledWith(
      "Error uploading artifact:",
      error,
    );
  });

  describe("waitForAll", () => {
    it("resolves immediately when no pending uploads", async () => {
      await tracker.waitForAll(1000);
    });

    it("resolves when all uploads complete", async () => {
      let resolve1!: () => void;
      let resolve2!: () => void;
      tracker.track(new Promise<void>((r) => { resolve1 = r; }));
      tracker.track(new Promise<void>((r) => { resolve2 = r; }));

      let waited = false;
      const waitPromise = tracker.waitForAll(5000).then(() => {
        waited = true;
      });

      resolve1();
      resolve2();
      await waitPromise;
      expect(waited).toBe(true);
    });

    it("times out if uploads do not complete", async () => {
      tracker.track(new Promise(() => {}));

      const start = Date.now();
      await tracker.waitForAll(50);
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
      expect(tracker.size).toBe(1);
    });
  });
});

async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 0));
}
