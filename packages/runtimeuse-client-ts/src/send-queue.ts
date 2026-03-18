/**
 * Simple async queue for outbound messages, analogous to asyncio.Queue.
 *
 * Supports put, get (blocking), join (wait until all items are processed),
 * and task_done acknowledgement.
 */
export class SendQueue {
  private queue: Record<string, unknown>[] = [];
  private waiters: Array<(value: Record<string, unknown>) => void> = [];
  private pending = 0;
  private joinResolvers: Array<() => void> = [];

  async put(item: Record<string, unknown>): Promise<void> {
    this.pending++;
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  async get(): Promise<Record<string, unknown>> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    return new Promise<Record<string, unknown>>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  taskDone(): void {
    this.pending--;
    if (this.pending === 0 && this.joinResolvers.length > 0) {
      for (const resolve of this.joinResolvers) {
        resolve();
      }
      this.joinResolvers = [];
    }
  }

  async join(): Promise<void> {
    if (this.pending === 0) return;
    return new Promise<void>((resolve) => {
      this.joinResolvers.push(resolve);
    });
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }
}
