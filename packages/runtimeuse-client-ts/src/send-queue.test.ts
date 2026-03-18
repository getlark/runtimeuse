import { describe, it, expect } from "vitest";
import { SendQueue } from "./send-queue.js";

describe("SendQueue", () => {
  it("put and get work in order", async () => {
    const q = new SendQueue();
    await q.put({ a: 1 });
    await q.put({ b: 2 });

    const first = await q.get();
    q.taskDone();
    const second = await q.get();
    q.taskDone();

    expect(first).toEqual({ a: 1 });
    expect(second).toEqual({ b: 2 });
  });

  it("get blocks until put", async () => {
    const q = new SendQueue();
    const promise = q.get();

    await q.put({ value: 42 });
    const result = await promise;
    q.taskDone();

    expect(result).toEqual({ value: 42 });
  });

  it("join resolves when all items are done", async () => {
    const q = new SendQueue();
    await q.put({ a: 1 });
    await q.put({ b: 2 });

    const item1 = await q.get();
    q.taskDone();
    const item2 = await q.get();
    q.taskDone();

    await q.join();
  });

  it("join resolves immediately when empty", async () => {
    const q = new SendQueue();
    await q.join();
  });

  it("isEmpty reflects queue state", async () => {
    const q = new SendQueue();
    expect(q.isEmpty()).toBe(true);

    await q.put({ a: 1 });
    expect(q.isEmpty()).toBe(false);

    await q.get();
    expect(q.isEmpty()).toBe(true);
  });
});
