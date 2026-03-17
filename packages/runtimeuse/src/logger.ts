import { redactSecrets } from "./utils.js";

export interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export function createLogger(sourceId: string): Logger {
  const prefix = `[${sourceId}]`;
  return {
    log: (...args: unknown[]) => console.log(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
    debug: (...args: unknown[]) => console.debug(prefix, ...args),
  };
}

export function createRedactingLogger(
  inner: Logger,
  secrets: string[],
): Logger {
  const redact = (args: unknown[]) =>
    args.map((a) => redactSecrets(a, secrets));
  return {
    log: (...args: unknown[]) => inner.log(...redact(args)),
    error: (...args: unknown[]) => inner.error(...redact(args)),
    debug: (...args: unknown[]) => inner.debug(...redact(args)),
  };
}

export const defaultLogger: Logger = {
  log: (...args: unknown[]) => console.log(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
};
