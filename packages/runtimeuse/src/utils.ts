export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Recursively redact secret values from an arbitrary data structure.
 * Any string that contains a secret will have that secret replaced with [REDACTED].
 */
export function redactSecrets<T>(value: T, secrets: string[]): T {
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

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, secrets)) as T;
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = redactSecrets(val, secrets);
    }
    return result as T;
  }

  return value;
}
