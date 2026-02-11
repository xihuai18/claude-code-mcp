import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager } from "../src/session/manager.js";

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("should create a session", () => {
    const session = manager.create({
      sessionId: "test-1",
      cwd: "/tmp",
      model: "claude-sonnet-4-5-20250929",
      permissionMode: "default",
    });

    expect(session.sessionId).toBe("test-1");
    expect(session.status).toBe("running");
    expect(session.cwd).toBe("/tmp");
    expect(session.model).toBe("claude-sonnet-4-5-20250929");
    expect(session.permissionMode).toBe("default");
    expect(session.totalTurns).toBe(0);
    expect(session.totalCostUsd).toBe(0);
  });

  it("should reject duplicate sessionId creation", () => {
    manager.create({ sessionId: "dup", cwd: "/tmp" });
    manager.update("dup", { status: "idle" });
    expect(() => manager.create({ sessionId: "dup", cwd: "/tmp" })).toThrow(/already exists/);
  });

  it("should get a session by ID", () => {
    manager.create({ sessionId: "test-1", cwd: "/tmp" });
    const session = manager.get("test-1");
    expect(session).toBeDefined();
    expect(session!.sessionId).toBe("test-1");
  });

  it("should return undefined for non-existent session", () => {
    expect(manager.get("non-existent")).toBeUndefined();
  });

  it("should list all sessions", () => {
    manager.create({ sessionId: "s1", cwd: "/a" });
    manager.create({ sessionId: "s2", cwd: "/b" });
    const sessions = manager.list();
    expect(sessions).toHaveLength(2);
  });

  it("should update a session", () => {
    manager.create({ sessionId: "test-1", cwd: "/tmp" });
    const updated = manager.update("test-1", {
      status: "idle",
      totalTurns: 5,
      totalCostUsd: 0.1,
    });
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("idle");
    expect(updated!.totalTurns).toBe(5);
    expect(updated!.totalCostUsd).toBe(0.1);
  });

  it("should return undefined when updating non-existent session", () => {
    expect(manager.update("nope", { status: "idle" })).toBeUndefined();
  });

  it("should cancel a running session", () => {
    const ac = new AbortController();
    manager.create({
      sessionId: "test-1",
      cwd: "/tmp",
      abortController: ac,
    });
    const cancelled = manager.cancel("test-1");
    expect(cancelled).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    expect(manager.get("test-1")!.status).toBe("cancelled");
  });

  it("should return false when cancelling non-existent session", () => {
    expect(manager.cancel("nope")).toBe(false);
  });

  it("should delete a session", () => {
    manager.create({ sessionId: "test-1", cwd: "/tmp" });
    expect(manager.delete("test-1")).toBe(true);
    expect(manager.get("test-1")).toBeUndefined();
  });

  it("should serialize session without abortController", () => {
    const ac = new AbortController();
    const session = manager.create({
      sessionId: "test-1",
      cwd: "/tmp",
      abortController: ac,
    });
    const json = manager.toJSON(session);
    expect(json).not.toHaveProperty("abortController");
    expect(json.sessionId).toBe("test-1");
  });

  it("should destroy all sessions on destroy", () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    manager.create({ sessionId: "s1", cwd: "/a", abortController: ac1 });
    manager.create({ sessionId: "s2", cwd: "/b", abortController: ac2 });
    manager.destroy();
    // Sessions are marked cancelled but not cleared (in-flight ops may still reference them)
    expect(manager.list()).toHaveLength(2);
    expect(manager.get("s1")!.status).toBe("cancelled");
    expect(manager.get("s2")!.status).toBe("cancelled");
    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
  });

  describe("tryAcquire", () => {
    it("should acquire session with matching status", () => {
      manager.create({ sessionId: "acq", cwd: "/tmp" });
      manager.update("acq", { status: "idle" });
      const ac = new AbortController();

      const acquired = manager.tryAcquire("acq", "idle", ac);

      expect(acquired).toBeDefined();
      expect(acquired!.status).toBe("running");
      expect(acquired!.abortController).toBe(ac);
    });

    it("should fail with non-matching status", () => {
      manager.create({ sessionId: "acq", cwd: "/tmp" });
      manager.update("acq", { status: "idle" });
      const ac = new AbortController();

      const acquired = manager.tryAcquire("acq", "error", ac);

      expect(acquired).toBeUndefined();
      expect(manager.get("acq")!.status).toBe("idle");
    });

    it("should fail for non-existent session", () => {
      const ac = new AbortController();
      expect(manager.tryAcquire("nope", "idle", ac)).toBeUndefined();
    });

    it("should prevent double acquire", () => {
      manager.create({ sessionId: "acq", cwd: "/tmp" });
      manager.update("acq", { status: "idle" });

      const ac1 = new AbortController();
      const ac2 = new AbortController();

      const first = manager.tryAcquire("acq", "idle", ac1);
      const second = manager.tryAcquire("acq", "idle", ac2);

      expect(first).toBeDefined();
      expect(second).toBeUndefined();
      expect(manager.get("acq")!.status).toBe("running");
    });

    it("should reject acquire from running status", () => {
      manager.create({ sessionId: "acq", cwd: "/tmp" });
      const ac = new AbortController();

      const acquired = manager.tryAcquire("acq", "running", ac);

      expect(acquired).toBeUndefined();
      expect(manager.get("acq")!.status).toBe("running");
    });

    it("should reject acquire from cancelled status", () => {
      const ac = new AbortController();
      manager.create({ sessionId: "acq", cwd: "/tmp", abortController: ac });
      manager.cancel("acq");

      const acquired = manager.tryAcquire("acq", "cancelled", new AbortController());

      expect(acquired).toBeUndefined();
      expect(manager.get("acq")!.status).toBe("cancelled");
    });
  });

  it("should cleanup idle sessions after TTL", async () => {
    vi.useFakeTimers();
    try {
      manager.destroy();
      vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
      manager = new SessionManager();
      manager.create({ sessionId: "ttl", cwd: "/tmp" });
      manager.update("ttl", { status: "idle" });

      vi.setSystemTime(new Date("2020-01-01T00:31:00.000Z"));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(manager.get("ttl")).toBeUndefined();
    } finally {
      manager.destroy();
      vi.useRealTimers();
    }
  });

  it("should abort and mark stuck running sessions as error after max time", () => {
    vi.useFakeTimers();
    try {
      const mgr = new SessionManager({
        runningSessionMaxMs: 5000,
        cleanupIntervalMs: 1000,
      });
      const ac = new AbortController();
      mgr.create({ sessionId: "stuck", cwd: "/tmp", abortController: ac });
      // Session is "running" with abortController

      // Advance past the running max time
      vi.advanceTimersByTime(6000);

      const session = mgr.get("stuck");
      expect(session).toBeDefined();
      expect(session!.status).toBe("error");
      expect(ac.signal.aborted).toBe(true);

      mgr.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should strip sensitive fields in toPublicJSON", () => {
    const mgr = new SessionManager();
    mgr.create({
      sessionId: "pub-test",
      cwd: "/secret/path",
      systemPrompt: "secret prompt",
      agents: { reviewer: { description: "test", prompt: "test" } },
      additionalDirectories: ["/extra"],
      mcpServers: { server1: { command: "test" } },
      sandbox: { enabled: true },
      env: { SECRET_KEY: "abc" },
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      settingSources: ["user", "project"],
      debugFile: "/tmp/debug.log",
    });
    mgr.update("pub-test", { status: "idle" });

    const session = mgr.get("pub-test")!;
    const pub = mgr.toPublicJSON(session);

    expect(pub.sessionId).toBe("pub-test");
    expect("cwd" in pub).toBe(false);
    expect("systemPrompt" in pub).toBe(false);
    expect("agents" in pub).toBe(false);
    expect("additionalDirectories" in pub).toBe(false);
    expect("mcpServers" in pub).toBe(false);
    expect("sandbox" in pub).toBe(false);
    expect("env" in pub).toBe(false);
    expect("pathToClaudeCodeExecutable" in pub).toBe(false);
    expect("settingSources" in pub).toBe(false);
    expect("debugFile" in pub).toBe(false);

    mgr.destroy();
  });
});
