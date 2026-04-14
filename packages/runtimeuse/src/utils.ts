export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Recursively redact secret values from an arbitrary data structure.
 * Any string that contains a secret will have that secret replaced with [REDACTED].
 */
export function redactSecrets<T>(value: T, secrets: string[], seen?: WeakMap<object, unknown>): T {
  if (secrets.length === 0) return value;

  if (typeof value === "string") {
    let redacted: string = value;
    for (const secret of secrets) {
      if (secret && redacted.includes(secret)) {
        redacted = redacted.replaceAll(secret, "[REDACTED]");
      }
    }
    return redacted as T;
  }

  if (value !== null && typeof value === "object") {
    if (!seen) seen = new WeakMap();
    if (seen.has(value as object)) return seen.get(value as object) as T;

    if (Array.isArray(value)) {
      const result: unknown[] = [];
      seen.set(value as object, result);
      for (const item of value) {
        result.push(redactSecrets(item, secrets, seen));
      }
      return result as T;
    }

    const result: Record<string, unknown> = {};
    seen.set(value as object, result);
    for (const [key, val] of Object.entries(value)) {
      result[key] = redactSecrets(val, secrets, seen);
    }
    return result as T;
  }

  return value;
}
