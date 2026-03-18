export class CancelledException extends Error {
  constructor(message = "Query was cancelled") {
    super(message);
    this.name = "CancelledException";
  }
}

export class AgentRuntimeError extends Error {
  readonly error: string;
  readonly metadata: Record<string, unknown> | null | undefined;

  constructor(
    error: string,
    metadata?: Record<string, unknown> | null,
  ) {
    const metadataStr = metadata
      ? (() => {
          try {
            return JSON.stringify(metadata, Object.keys(metadata).sort());
          } catch {
            return String(metadata);
          }
        })()
      : null;

    super(metadataStr ? `${error}\nmetadata: ${metadataStr}` : error);
    this.name = "AgentRuntimeError";
    this.error = error;
    this.metadata = metadata;
  }
}
