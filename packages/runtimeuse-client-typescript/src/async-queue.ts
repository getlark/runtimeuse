/**
 * Simple async queue with put/get/join/taskDone semantics,
 * mirroring Python's asyncio.Queue for the transport layer.
 */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(item: T) => void> = [];
  private pendingCount = 0;
  private joinResolvers: Array<() => void> = [];

  async put(item: T): Promise<void> {
    this.pendingCount++;
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  async get(): Promise<T> {
    if (this.items.length > 0) {
      return this.items.shift()!;
    }
    return new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  taskDone(): void {
    this.pendingCount--;
    if (this.pendingCount === 0 && this.joinResolvers.length > 0) {
      for (const resolver of this.joinResolvers) {
        resolver();
      }
      this.joinResolvers = [];
    }
  }

  async join(): Promise<void> {
    if (this.pendingCount === 0) return;
    return new Promise<void>((resolve) => {
      this.joinResolvers.push(resolve);
    });
  }

  empty(): boolean {
    return this.items.length === 0;
  }
}
