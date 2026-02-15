import { describe, it, expect } from "vitest";
import { normalizePermissionUpdatedInput } from "../src/utils/permission-updated-input.js";

describe("normalizePermissionUpdatedInput", () => {
  it("passes through plain objects", () => {
    const input = { cmd: "echo hi" };
    const out = normalizePermissionUpdatedInput(input);
    expect(out).toBe(input);
    expect(out).toEqual({ cmd: "echo hi" });
  });

  it("wraps null and undefined", () => {
    expect(normalizePermissionUpdatedInput(null)).toEqual({ input: null });
    expect(normalizePermissionUpdatedInput(undefined)).toEqual({ input: undefined });
  });

  it("wraps arrays and primitives", () => {
    expect(normalizePermissionUpdatedInput([1, 2])).toEqual({ input: [1, 2] });
    expect(normalizePermissionUpdatedInput("x")).toEqual({ input: "x" });
    expect(normalizePermissionUpdatedInput(42)).toEqual({ input: 42 });
    expect(normalizePermissionUpdatedInput(false)).toEqual({ input: false });
  });
});
