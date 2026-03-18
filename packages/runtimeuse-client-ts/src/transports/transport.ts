import type { SendQueue } from "../send-queue.js";

/**
 * Transport interface for the underlying message transport.
 *
 * Implementations must be callable that return an async iterable yielding
 * parsed messages (objects) from the agent runtime. They consume outbound
 * messages from the send queue.
 */
export type Transport = (
  sendQueue: SendQueue
) => AsyncIterable<Record<string, unknown>>;
