import { redactSecrets } from "./utils.js";

export interface Logger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export function createLogger(sourceId: string): Logger {
  const prefix = `[${sourceId}]`;
  return {
    log: (...args: unknown[]) => console.log(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
    debug: (...args: unknown[]) => console.debug(prefix, ...args),
  };
}

export function createRedactingLogger(
  inner: Logger,
  secrets: string[],
): Logger {
  const redact = (args: unknown[]) =>
    args.map((a) => {
      // Error instances have non-enumerable message/stack, so passing them
      // through redactSecrets (which uses Object.entries) would produce `{}`
      // and lose the error details. Convert to a string first so the stack
      // is preserved and can still be redacted.
      if (a instanceof Error) {
        return redactSecrets(a.stack ?? a.message, secrets);
      }
      return redactSecrets(a, secrets);
    });
  return {
    log: (...args: unknown[]) => inner.log(...redact(args)),
    warn: (...args: unknown[]) => inner.warn(...redact(args)),
    error: (...args: unknown[]) => inner.error(...redact(args)),
    debug: (...args: unknown[]) => inner.debug(...redact(args)),
  };
}

export const defaultLogger: Logger = {
  log: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
};
