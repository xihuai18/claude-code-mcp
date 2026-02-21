import { describe, expect, it } from "vitest";
import { isBenignRuntimeError } from "../src/utils/runtime-errors.js";

describe("isBenignRuntimeError", () => {
  it("returns true for AbortError-like failures", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(isBenignRuntimeError(err)).toBe(true);
  });

  it("returns true for stream teardown errors", () => {
    const err = new Error("write after end");
    (err as { code?: string }).code = "ERR_STREAM_WRITE_AFTER_END";
    expect(isBenignRuntimeError(err)).toBe(true);
  });

  it("returns true for transport closed messages", () => {
    const err = new Error("tools/call failed: Transport closed");
    expect(isBenignRuntimeError(err)).toBe(true);
  });

  it("returns true for query-close teardown messages", () => {
    const err = new Error("Query closed before response received");
    expect(isBenignRuntimeError(err)).toBe(true);
  });

  it("returns false for normal runtime errors", () => {
    const err = new Error("ReferenceError: x is not defined");
    expect(isBenignRuntimeError(err)).toBe(false);
  });
});
