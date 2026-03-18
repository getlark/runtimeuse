import { describe, it, expect } from "vitest";
import { AgentRuntimeError, CancelledException } from "./exceptions.js";

describe("CancelledException", () => {
  it("has default message", () => {
    const err = new CancelledException();
    expect(err.message).toBe("Query was cancelled");
    expect(err.name).toBe("CancelledException");
  });

  it("accepts custom message", () => {
    const err = new CancelledException("custom");
    expect(err.message).toBe("custom");
  });
});

describe("AgentRuntimeError", () => {
  it("stores error and metadata", () => {
    const err = new AgentRuntimeError("broke", { code: 500 });
    expect(err.error).toBe("broke");
    expect(err.metadata).toEqual({ code: 500 });
    expect(err.name).toBe("AgentRuntimeError");
  });

  it("formats message without metadata", () => {
    const err = new AgentRuntimeError("oops");
    expect(err.message).toBe("oops");
    expect(err.metadata).toBeUndefined();
  });

  it("formats message with metadata", () => {
    const err = new AgentRuntimeError("broke", { code: 500 });
    expect(err.message).toContain("broke");
    expect(err.message).toContain("metadata:");
    expect(err.message).toContain("500");
  });
});
