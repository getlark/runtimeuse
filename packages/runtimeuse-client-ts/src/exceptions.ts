export class CancelledException extends Error {
  constructor(message = "Query was cancelled") {
    super(message);
    this.name = "CancelledException";
  }
}

export class AgentRuntimeError extends Error {
  readonly error: string;
  readonly metadata?: Record<string, unknown>;

  constructor(error: string, metadata?: Record<string, unknown>) {
    let msg = error;
    if (metadata) {
      try {
        const metadataStr = JSON.stringify(metadata, Object.keys(metadata).sort());
        msg = `${error}\nmetadata: ${metadataStr}`;
      } catch {
        msg = `${error}\nmetadata: ${String(metadata)}`;
      }
    }
    super(msg);
    this.name = "AgentRuntimeError";
    this.error = error;
    this.metadata = metadata;
  }
}
