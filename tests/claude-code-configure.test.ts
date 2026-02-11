import { describe, it, expect, beforeEach } from "vitest";
import { executeClaudeCodeConfigure } from "../src/tools/claude-code-configure.js";

describe("claude_code_configure tool", () => {
  let allowBypass: boolean;
  let config: {
    getAllowBypass: () => boolean;
    setAllowBypass: (v: boolean) => void;
  };

  beforeEach(() => {
    allowBypass = false;
    config = {
      getAllowBypass: () => allowBypass,
      setAllowBypass: (v: boolean) => {
        allowBypass = v;
      },
    };
  });

  describe("enable_bypass action", () => {
    it("should enable bypass mode", () => {
      const result = executeClaudeCodeConfigure({ action: "enable_bypass" }, config);
      expect(result.allowBypass).toBe(true);
      expect(result.isError).toBeUndefined();
      expect(allowBypass).toBe(true);
    });

    it("should return confirmation message", () => {
      const result = executeClaudeCodeConfigure({ action: "enable_bypass" }, config);
      expect(result.message).toContain("enabled");
    });
  });

  describe("disable_bypass action", () => {
    it("should disable bypass mode", () => {
      allowBypass = true;
      const result = executeClaudeCodeConfigure({ action: "disable_bypass" }, config);
      expect(result.allowBypass).toBe(false);
      expect(result.isError).toBeUndefined();
      expect(allowBypass).toBe(false);
    });

    it("should return confirmation message", () => {
      const result = executeClaudeCodeConfigure({ action: "disable_bypass" }, config);
      expect(result.message).toContain("disabled");
    });
  });

  describe("get_config action", () => {
    it("should return current config when bypass is disabled", () => {
      const result = executeClaudeCodeConfigure({ action: "get_config" }, config);
      expect(result.allowBypass).toBe(false);
      expect(result.message).toContain("disabled");
      expect(result.isError).toBeUndefined();
    });

    it("should return current config when bypass is enabled", () => {
      allowBypass = true;
      const result = executeClaudeCodeConfigure({ action: "get_config" }, config);
      expect(result.allowBypass).toBe(true);
      expect(result.message).toContain("enabled");
    });
  });

  describe("invalid action", () => {
    it("should return error for unknown action", () => {
      const result = executeClaudeCodeConfigure({ action: "unknown" as any }, config);
      expect(result.isError).toBe(true);
      expect(result.message).toContain("INVALID_ARGUMENT");
    });
  });

  describe("state transitions", () => {
    it("should toggle bypass mode on and off", () => {
      executeClaudeCodeConfigure({ action: "enable_bypass" }, config);
      expect(allowBypass).toBe(true);

      executeClaudeCodeConfigure({ action: "disable_bypass" }, config);
      expect(allowBypass).toBe(false);
    });

    it("enable_bypass should be idempotent", () => {
      executeClaudeCodeConfigure({ action: "enable_bypass" }, config);
      executeClaudeCodeConfigure({ action: "enable_bypass" }, config);
      expect(allowBypass).toBe(true);
    });
  });
});
