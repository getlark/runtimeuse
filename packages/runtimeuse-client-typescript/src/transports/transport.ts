import { AsyncQueue } from "../async-queue.js";

/**
 * Transport interface for the underlying message transport.
 *
 * Implementations must be callable and return an async iterable that yields
 * parsed messages (plain objects) from the agent runtime, while consuming
 * outbound messages from the sendQueue.
 */
export type Transport = (
  sendQueue: AsyncQueue<Record<string, unknown>>,
) => AsyncIterable<Record<string, unknown>>;
