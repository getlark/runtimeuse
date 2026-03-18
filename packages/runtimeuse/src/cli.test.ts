import { describe, it, expect } from "vitest";
import { parseArgs } from "./cli.js";

describe("parseArgs", () => {
  const noopHelp = (): never => {
    throw new Error("help called");
  };

  it("parses --key value (space-separated)", () => {
    expect(parseArgs(["--agent", "claude"], noopHelp)).toEqual({
      agent: "claude",
    });
  });

  it("parses --key=value (equals-separated)", () => {
    expect(parseArgs(["--agent=claude"], noopHelp)).toEqual({
      agent: "claude",
    });
  });

  it("handles a mix of space and equals styles", () => {
    expect(
      parseArgs(["--agent=claude", "--port", "3000"], noopHelp),
    ).toEqual({ agent: "claude", port: "3000" });
  });

  it("handles equals style followed by space style", () => {
    expect(
      parseArgs(["--port=8080", "--handler", "./my-handler.js"], noopHelp),
    ).toEqual({ port: "8080", handler: "./my-handler.js" });
  });

  it("handles value containing an equals sign", () => {
    expect(parseArgs(["--handler=path/to/file=v2.js"], noopHelp)).toEqual({
      handler: "path/to/file=v2.js",
    });
  });

  it("returns empty object for no args", () => {
    expect(parseArgs([], noopHelp)).toEqual({});
  });

  it("ignores bare flags without a following value", () => {
    expect(parseArgs(["--verbose"], noopHelp)).toEqual({});
  });

  it("last value wins when a key is repeated", () => {
    expect(
      parseArgs(["--port", "3000", "--port=4000"], noopHelp),
    ).toEqual({ port: "4000" });
  });

  it("calls onHelp for -h", () => {
    expect(() => parseArgs(["-h"], noopHelp)).toThrow("help called");
  });

  it("calls onHelp for --help", () => {
    expect(() => parseArgs(["--help"], noopHelp)).toThrow("help called");
  });

  it("skips non-flag arguments", () => {
    expect(parseArgs(["positional", "--port", "8080"], noopHelp)).toEqual({
      port: "8080",
    });
  });
});
