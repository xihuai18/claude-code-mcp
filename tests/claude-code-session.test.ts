import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
      expect(result.sessions[0]).toHaveProperty("pendingPermissionCount", 0);
      expect(result.sessions[0]).toHaveProperty("eventCount", 0);
      expect(result.sessions[0]).toHaveProperty("currentCursor", 0);
      expect(result.sessions[0]).toHaveProperty("ttlMs");
      expect(result.sessions[0]).toHaveProperty("redactions");
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
      const redactions = result.sessions[0].redactions ?? [];
      expect(redactions.some((r) => r.field === "cwd")).toBe(true);
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
      const redactions = result.sessions[0].redactions ?? [];
      expect(redactions.some((r) => r.field === "cwd")).toBe(false);
      expect(redactions.some((r) => r.field === "env")).toBe(true);
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

    it("should surface lastError diagnostics when session result is error", () => {
      manager.create({ sessionId: "s-error", cwd: "/tmp" });
      manager.setResult("s-error", {
        type: "error",
        result: {
          sessionId: "s-error",
          result: "tool failed",
          isError: true,
          durationMs: 1,
          numTurns: 1,
          totalCostUsd: 0,
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const result = executeClaudeCodeSession({ action: "get", sessionId: "s-error" }, manager);
      expect(result.sessions[0]).toHaveProperty("lastError", "tool failed");
      expect(result.sessions[0]).toHaveProperty("lastErrorAt", "2026-01-01T00:00:00.000Z");
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

  describe("interrupt action", () => {
    it("should return error without sessionId", () => {
      const result = executeClaudeCodeSession({ action: "interrupt" }, manager);
      expect(result.isError).toBe(true);
      expect(result.message).toContain("INVALID_ARGUMENT");
    });

    it("should interrupt a running session without cancelling it", () => {
      const ac = new AbortController();
      const queryInterrupt = vi.fn();
      manager.create({
        sessionId: "s-int",
        cwd: "/tmp",
        abortController: ac,
        queryInterrupt,
      });

      const result = executeClaudeCodeSession({ action: "interrupt", sessionId: "s-int" }, manager);
      expect(result.message).toContain("interrupted");
      expect(queryInterrupt).toHaveBeenCalledTimes(1);
      expect(ac.signal.aborted).toBe(true);
      expect(manager.get("s-int")?.status).toBe("running");
      expect(manager.get("s-int")?.cancelledAt).toBeUndefined();
      expect(manager.get("s-int")?.cancelledReason).toBeUndefined();
      expect(manager.get("s-int")?.cancelledSource).toBeUndefined();
    });

    it("should interrupt waiting_permission sessions and clear pending requests", () => {
      const ac = new AbortController();
      const finish = vi.fn();
      manager.create({
        sessionId: "s-int-wait",
        cwd: "/tmp",
        abortController: ac,
        queryInterrupt: vi.fn(),
      });
      manager.setPendingPermission(
        "s-int-wait",
        {
          requestId: "req-int",
          toolName: "Bash",
          input: { command: "echo hi" },
          summary: "run command",
          toolUseID: "tu-int",
          createdAt: new Date().toISOString(),
        },
        finish,
        60_000
      );

      const result = executeClaudeCodeSession(
        { action: "interrupt", sessionId: "s-int-wait" },
        manager
      );
      expect(result.message).toContain("interrupted");
      expect(result.isError).toBeUndefined();
      expect(ac.signal.aborted).toBe(true);
      expect(finish).toHaveBeenCalledTimes(1);
      expect(manager.getPendingPermissionCount("s-int-wait")).toBe(0);
      expect(manager.get("s-int-wait")?.status).toBe("running");
    });

    it("should return error for non-existent session", () => {
      const result = executeClaudeCodeSession({ action: "interrupt", sessionId: "nope" }, manager);
      expect(result.isError).toBe(true);
      expect(result.message).toContain("SESSION_NOT_FOUND");
    });

    it("should return error for non-running session", () => {
      manager.create({ sessionId: "s-idle", cwd: "/tmp" });
      manager.update("s-idle", { status: "idle" });

      const result = executeClaudeCodeSession(
        { action: "interrupt", sessionId: "s-idle" },
        manager
      );
      expect(result.isError).toBe(true);
      expect(result.message).toContain("not running");
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
