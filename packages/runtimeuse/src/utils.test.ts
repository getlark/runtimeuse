import { describe, it, expect } from "vitest";
import { redactSecrets } from "./utils.js";

describe("redactSecrets", () => {
  describe("strings", () => {
    it("replaces a secret within a string", () => {
      expect(redactSecrets("token is abc123", ["abc123"])).toBe(
        "token is [REDACTED]",
      );
    });

    it("replaces multiple occurrences of the same secret", () => {
      expect(redactSecrets("abc123 and abc123", ["abc123"])).toBe(
        "[REDACTED] and [REDACTED]",
      );
    });

    it("replaces multiple different secrets", () => {
      expect(redactSecrets("key=SECRET1 pass=SECRET2", ["SECRET1", "SECRET2"])).toBe(
        "key=[REDACTED] pass=[REDACTED]",
      );
    });

    it("returns string unchanged when no secrets match", () => {
      expect(redactSecrets("nothing here", ["xyz"])).toBe("nothing here");
    });

    it("skips empty-string secrets", () => {
      expect(redactSecrets("hello", [""])).toBe("hello");
    });
  });

  describe("arrays", () => {
    it("redacts secrets inside array elements", () => {
      expect(redactSecrets(["key=SECRET", "ok"], ["SECRET"])).toEqual([
        "key=[REDACTED]",
        "ok",
      ]);
    });

    it("handles nested arrays", () => {
      expect(redactSecrets([["SECRET"]], ["SECRET"])).toEqual([
        ["[REDACTED]"],
      ]);
    });
  });

  describe("objects", () => {
    it("redacts secrets in object values", () => {
      expect(
        redactSecrets({ token: "my-SECRET-value", count: 5 }, ["SECRET"]),
      ).toEqual({ token: "my-[REDACTED]-value", count: 5 });
    });

    it("redacts secrets in deeply nested objects", () => {
      const input = {
        level1: {
          level2: {
            value: "contains SECRET here",
          },
        },
      };
      expect(redactSecrets(input, ["SECRET"])).toEqual({
        level1: {
          level2: {
            value: "contains [REDACTED] here",
          },
        },
      });
    });

    it("handles mixed objects with arrays", () => {
      const input = {
        args: ["--token=SECRET", "--verbose"],
        env: { API_KEY: "SECRET" },
      };
      expect(redactSecrets(input, ["SECRET"])).toEqual({
        args: ["--token=[REDACTED]", "--verbose"],
        env: { API_KEY: "[REDACTED]" },
      });
    });
  });

  describe("non-string primitives", () => {
    it("returns numbers unchanged", () => {
      expect(redactSecrets(42, ["42"])).toBe(42);
    });

    it("returns booleans unchanged", () => {
      expect(redactSecrets(true, ["true"])).toBe(true);
    });

    it("returns null unchanged", () => {
      expect(redactSecrets(null, ["null"])).toBeNull();
    });

    it("returns undefined unchanged", () => {
      expect(redactSecrets(undefined, ["undefined"])).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("returns value unchanged when secrets list is empty", () => {
      const input = { key: "value" };
      expect(redactSecrets(input, [])).toBe(input);
    });

    it("handles overlapping secrets (longer secret first)", () => {
      expect(
        redactSecrets("my-secret-key", ["my-secret-key", "secret"]),
      ).toBe("[REDACTED]");
    });

    it("handles overlapping secrets (shorter secret first)", () => {
      expect(
        redactSecrets("my-secret-key", ["secret", "my-secret-key"]),
      ).toBe("my-[REDACTED]-key");
    });
  });
});
