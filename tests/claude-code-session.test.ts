import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionManager } from "../src/session/manager.js";
import { executeClaudeCodeSession } from "../src/tools/claude-code-session.js";
import type { SessionAction } from "../src/types.js";

describe("claude_code_session tool", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  describe("list action", () => {
    it("should return empty list when no sessions", () => {
      const result = executeClaudeCodeSession({ action: "list" }, manager);
      expect(result.sessions).toHaveLength(0);
      expect(result.isError).toBeUndefined();
    });

    it("should list all sessions", () => {
      manager.create({ sessionId: "s1", cwd: "/a" });
      manager.create({ sessionId: "s2", cwd: "/b" });
      const result = executeClaudeCodeSession({ action: "list" }, manager);
      expect(result.sessions).toHaveLength(2);
    });
  });

  describe("get action", () => {
    it("should return error without sessionId", () => {
      const result = executeClaudeCodeSession({ action: "get" }, manager);
      expect(result.isError).toBe(true);
      expect(result.message).toContain("INVALID_ARGUMENT");
    });

    it("should return error for non-existent session", () => {
      const result = executeClaudeCodeSession({ action: "get", sessionId: "nope" }, manager);
      expect(result.isError).toBe(true);
      expect(result.message).toContain("SESSION_NOT_FOUND");
    });

    it("should return session info", () => {
      manager.create({ sessionId: "s1", cwd: "/tmp" });
      const result = executeClaudeCodeSession({ action: "get", sessionId: "s1" }, manager);
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toHaveProperty("sessionId", "s1");
      // Should not expose abortController
      expect(result.sessions[0]).not.toHaveProperty("abortController");
    });

    it("should redact sensitive fields by default", () => {
      manager.create({
        sessionId: "s-sensitive",
        cwd: "/tmp",
        systemPrompt: "secret",
        additionalDirectories: ["/private"],
      });
      const result = executeClaudeCodeSession({ action: "get", sessionId: "s-sensitive" }, manager);
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).not.toHaveProperty("cwd");
      expect(result.sessions[0]).not.toHaveProperty("systemPrompt");
      expect(result.sessions[0]).not.toHaveProperty("additionalDirectories");
    });

    it("should include sensitive fields when requested", () => {
      manager.create({
        sessionId: "s-sensitive-yes",
        cwd: "/tmp",
        systemPrompt: "secret",
        additionalDirectories: ["/private"],
      });
      const result = executeClaudeCodeSession(
        { action: "get", sessionId: "s-sensitive-yes", includeSensitive: true },
        manager
      );
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toHaveProperty("cwd", "/tmp");
      expect(result.sessions[0]).toHaveProperty("systemPrompt", "secret");
      expect(result.sessions[0]).toHaveProperty("additionalDirectories");
    });

    it("should not leak secrets even with includeSensitive", () => {
      manager.create({
        sessionId: "s-no-leak",
        cwd: "/tmp",
        env: { SECRET: "password" },
        mcpServers: { srv: { command: "test" } },
        sandbox: { enabled: true },
        debugFile: "/tmp/debug.log",
        pathToClaudeCodeExecutable: "/usr/bin/claude",
      });
      const result = executeClaudeCodeSession(
        { action: "get", sessionId: "s-no-leak", includeSensitive: true },
        manager
      );
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toHaveProperty("cwd", "/tmp");
      expect(result.sessions[0]).not.toHaveProperty("env");
      expect(result.sessions[0]).not.toHaveProperty("mcpServers");
      expect(result.sessions[0]).not.toHaveProperty("sandbox");
      expect(result.sessions[0]).not.toHaveProperty("debugFile");
      expect(result.sessions[0]).not.toHaveProperty("pathToClaudeCodeExecutable");
    });
  });

  describe("cancel action", () => {
    it("should return error without sessionId", () => {
      const result = executeClaudeCodeSession({ action: "cancel" }, manager);
      expect(result.isError).toBe(true);
      expect(result.message).toContain("INVALID_ARGUMENT");
    });

    it("should cancel a running session", () => {
      const ac = new AbortController();
      manager.create({
        sessionId: "s1",
        cwd: "/tmp",
        abortController: ac,
      });
      const result = executeClaudeCodeSession({ action: "cancel", sessionId: "s1" }, manager);
      expect(result.message).toContain("cancelled");
      expect(ac.signal.aborted).toBe(true);
    });

    it("should return error for non-existent session", () => {
      const result = executeClaudeCodeSession({ action: "cancel", sessionId: "nope" }, manager);
      expect(result.isError).toBe(true);
      expect(result.message).toContain("SESSION_NOT_FOUND");
    });
  });

  describe("invalid action", () => {
    it("should return error for unknown action", () => {
      const result = executeClaudeCodeSession(
        { action: "invalid" as unknown as SessionAction },
        manager
      );
      expect(result.isError).toBe(true);
      expect(result.message).toContain("INVALID_ARGUMENT");
    });
  });
});
