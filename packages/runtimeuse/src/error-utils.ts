import { redactSecrets } from "./utils.js";

const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 20;
const MAX_STRING_LENGTH = 4_000;

type ErrorWithMetadata = Error & {
  cause?: unknown;
  metadata?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

function toSerializable(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return truncateString(value);
  }

  if (depth >= MAX_DEPTH) {
    return "[max depth reached]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => toSerializable(item, depth + 1));
  }

  if (value instanceof Error) {
    return serializeErrorMetadata(value);
  }

  if (isRecord(value)) {
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [
        key,
        toSerializable(entryValue, depth + 1),
      ]),
    );
  }

  return String(value);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  const serializable = toSerializable(error);
  if (typeof serializable === "string") {
    return serializable;
  }
  return JSON.stringify(serializable);
}

export function serializeErrorMetadata(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const typedError = error as ErrorWithMetadata;
    const metadata: Record<string, unknown> = {
      error_name: error.name,
    };

    if (error.stack) {
      metadata.stack = truncateString(error.stack);
    }
    if (typedError.cause !== undefined) {
      metadata.cause = toSerializable(typedError.cause);
    }
    if (isRecord(typedError.metadata)) {
      const serializedMetadata = toSerializable(typedError.metadata);
      if (isRecord(serializedMetadata)) {
        Object.assign(metadata, serializedMetadata);
      }
    }

    const extraEntries = Object.entries(typedError).filter(
      ([key]) => !["name", "message", "stack", "cause", "metadata"].includes(key),
    );
    if (extraEntries.length > 0) {
      metadata.error_details = Object.fromEntries(
        extraEntries.map(([key, value]) => [key, toSerializable(value)]),
      );
    }

    return metadata;
  }

  if (typeof error === "string") {
    return { error_type: "string" };
  }

  if (error && typeof error === "object") {
    return {
      error_type: "object",
      error_details: toSerializable(error),
    };
  }

  return { error_type: typeof error };
}

export function redactError(error: unknown, secrets: string[]): unknown {
  if (secrets.length === 0) return error;

  if (error instanceof Error) {
    const redacted = new Error(redactSecrets(error.message, secrets));
    redacted.name = error.name;
    if (error.stack) {
      redacted.stack = redactSecrets(error.stack, secrets);
    }
    if (error.cause !== undefined) {
      redacted.cause = redactError(error.cause, secrets);
    }
    for (const [key, val] of Object.entries(error)) {
      if (!["name", "message", "stack", "cause"].includes(key)) {
        (redacted as unknown as Record<string, unknown>)[key] = redactSecrets(val, secrets);
      }
    }
    return redacted;
  }

  return redactSecrets(error, secrets);
}

export function withErrorMetadata(
  error: unknown,
  metadata: Record<string, unknown>,
): Error {
  if (error instanceof Error) {
    const typedError = error as ErrorWithMetadata;
    const existingMetadata = isRecord(typedError.metadata)
      ? typedError.metadata
      : {};
    typedError.metadata = {
      ...existingMetadata,
      ...metadata,
    };
    return error;
  }

  const wrapped = new Error(getErrorMessage(error));
  (wrapped as ErrorWithMetadata).metadata = metadata;
  return wrapped;
}
