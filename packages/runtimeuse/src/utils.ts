export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Recursively redact secret values from an arbitrary data structure.
 * Any string that contains a secret will have that secret replaced with [REDACTED].
 */
export function redactSecrets<T>(value: T, secrets: string[]): T {
  if (secrets.length === 0) return value;

  const seen = new WeakMap<object, unknown>();

  function redact<U>(val: U): U {
    if (typeof val === "string") {
      let redacted: string = val;
      for (const secret of secrets) {
        if (secret && redacted.includes(secret)) {
          redacted = redacted.replaceAll(secret, "[REDACTED]");
        }
      }
      return redacted as U;
    }

    if (val !== null && typeof val === "object") {
      if (seen.has(val as object)) return seen.get(val as object) as U;

      if (Array.isArray(val)) {
        const result: unknown[] = [];
        seen.set(val as object, result);
        for (const item of val) {
          result.push(redact(item));
        }
        return result as U;
      }

      const result: Record<string, unknown> = {};
      seen.set(val as object, result);
      for (const [key, v] of Object.entries(val)) {
        result[key] = redact(v);
      }
      return result as U;
    }

    return val;
  }

  return redact(value);
}
