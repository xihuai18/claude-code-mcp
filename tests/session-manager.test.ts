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

  it("should interrupt a running session without transitioning to cancelled", () => {
    const ac = new AbortController();
    const queryInterrupt = vi.fn();
    manager.create({
      sessionId: "int-1",
      cwd: "/tmp",
      abortController: ac,
      queryInterrupt,
    });

    const interrupted = manager.interrupt("int-1", { reason: "manual" });
    expect(interrupted).toBe(true);
    expect(queryInterrupt).toHaveBeenCalledTimes(1);
    expect(ac.signal.aborted).toBe(true);
    expect(manager.get("int-1")!.status).toBe("running");

    const events = manager.readEvents("int-1").events;
    const interruptEvent = events.find((e) => e.type === "progress");
    expect(interruptEvent).toBeDefined();
    expect(interruptEvent?.data).toMatchObject({ type: "interrupted", reason: "manual" });
  });

  it("should return false when interrupting non-running sessions", () => {
    manager.create({ sessionId: "int-idle", cwd: "/tmp" });
    manager.update("int-idle", { status: "idle" });
    expect(manager.interrupt("int-idle")).toBe(false);
  });

  it("should interrupt waiting_permission sessions, deny pending requests, and return to running", () => {
    const ac = new AbortController();
    const queryInterrupt = vi.fn();
    manager.create({
      sessionId: "int-waiting",
      cwd: "/tmp",
      abortController: ac,
      queryInterrupt,
    });
    const finish = vi.fn();
    manager.setPendingPermission(
      "int-waiting",
      {
        requestId: "req-waiting",
        toolName: "Bash",
        input: { command: "echo hi" },
        summary: "run command",
        toolUseID: "tu-waiting",
        createdAt: new Date().toISOString(),
      },
      finish,
      60_000
    );

    const interrupted = manager.interrupt("int-waiting", { reason: "manual-stop" });
    expect(interrupted).toBe(true);
    expect(queryInterrupt).toHaveBeenCalledTimes(1);
    expect(ac.signal.aborted).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0]?.[0]).toMatchObject({
      behavior: "deny",
      message: "manual-stop",
      interrupt: false,
    });
    expect(manager.getPendingPermissionCount("int-waiting")).toBe(0);
    expect(manager.get("int-waiting")?.status).toBe("running");

    const events = manager.readEvents("int-waiting").events;
    const permissionResult = events.find((event) => event.type === "permission_result");
    expect((permissionResult?.data as { behavior?: string; source?: string }).behavior).toBe(
      "deny"
    );
    expect((permissionResult?.data as { behavior?: string; source?: string }).source).toBe(
      "interrupt"
    );
    const interruptProgress = events.find(
      (event) =>
        event.type === "progress" &&
        (event.data as { type?: string; reason?: string }).type === "interrupted"
    );
    expect(interruptProgress).toBeDefined();
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
    expect(manager.list()).toHaveLength(0);
    expect(manager.getSessionCount()).toBe(0);
    expect(manager.get("s1")).toBeUndefined();
    expect(manager.get("s2")).toBeUndefined();
    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
  });

  it("should reject new work after destroy", () => {
    manager.destroy();
    expect(manager.hasCapacityFor(1)).toBe(false);
    expect(manager.get("s1")).toBeUndefined();
    expect(() => manager.create({ sessionId: "s1", cwd: "/tmp" })).toThrow(/destroyed/i);
  });

  it("should deny and finish pending permissions during destroy", () => {
    manager.create({ sessionId: "destroy-perm", cwd: "/tmp" });
    const finish = vi.fn();
    manager.setPendingPermission(
      "destroy-perm",
      {
        requestId: "req-1",
        toolName: "Bash",
        input: { command: "echo hi" },
        summary: "permission",
        toolUseID: "tool-1",
        createdAt: new Date().toISOString(),
      },
      finish,
      60_000
    );

    manager.destroy();

    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0]?.[0]).toMatchObject({
      behavior: "deny",
      interrupt: true,
      message: "Server shutting down",
    });
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

  it("should abort and mark stuck running sessions as cancelled after max time", () => {
    vi.useFakeTimers();
    try {
      const mgr = new SessionManager();
      const ac = new AbortController();
      mgr.create({ sessionId: "stuck", cwd: "/tmp", abortController: ac });
      // Session is "running" with abortController

      // Advance past the running max time (default 4 hours)
      vi.advanceTimersByTime(4 * 60 * 60 * 1000 + 60_000);

      const session = mgr.get("stuck");
      expect(session).toBeDefined();
      expect(session!.status).toBe("cancelled");
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

  it("should include controlled sensitive fields in toSensitiveJSON but exclude secrets", () => {
    const mgr = new SessionManager();
    mgr.create({
      sessionId: "sens-test",
      cwd: "/secret/path",
      systemPrompt: "secret prompt",
      agents: { reviewer: { description: "test", prompt: "test" } },
      additionalDirectories: ["/extra"],
      mcpServers: { server1: { command: "test" } },
      sandbox: { enabled: true },
      env: { SECRET_KEY: "abc" },
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      debugFile: "/tmp/debug.log",
    });
    mgr.update("sens-test", { status: "idle" });

    const session = mgr.get("sens-test")!;
    const sens = mgr.toSensitiveJSON(session);

    // Should include the documented sensitive fields
    expect(sens.sessionId).toBe("sens-test");
    expect(sens.cwd).toBe("/secret/path");
    expect(sens.systemPrompt).toBe("secret prompt");
    expect(sens.agents).toEqual({ reviewer: { description: "test", prompt: "test" } });
    expect(sens.additionalDirectories).toEqual(["/extra"]);

    // Should still exclude secrets
    expect("env" in sens).toBe(false);
    expect("mcpServers" in sens).toBe(false);
    expect("sandbox" in sens).toBe(false);
    expect("pathToClaudeCodeExecutable" in sens).toBe(false);
    expect("debugFile" in sens).toBe(false);
    expect("abortController" in sens).toBe(false);

    mgr.destroy();
  });

  describe("event buffer + permissions", () => {
    it("should clamp hard max to max size when configured lower", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mgr = new SessionManager({ eventBufferMaxSize: 12, eventBufferHardMaxSize: 6 });
      try {
        expect(mgr.getEventBufferConfig()).toEqual({ maxSize: 12, hardMaxSize: 12 });
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        mgr.destroy();
      }
    });

    it("should read from cursor via monotonic event ids", () => {
      manager.create({ sessionId: "cursor", cwd: "/tmp" });
      for (let i = 0; i < 10; i++) {
        manager.pushEvent("cursor", {
          type: "output",
          data: { i },
          timestamp: new Date().toISOString(),
        });
      }

      const res = manager.readEvents("cursor", 6);
      expect(res.events.map((e) => e.id)).toEqual([6, 7, 8, 9]);
      expect(res.nextCursor).toBe(10);
    });

    it("should support cursorResetTo when old events are evicted", () => {
      manager.create({ sessionId: "buf", cwd: "/tmp" });
      for (let i = 0; i < 1005; i++) {
        manager.pushEvent("buf", {
          type: "output",
          data: { i },
          timestamp: new Date().toISOString(),
        });
      }

      const res = manager.readEvents("buf", 1);
      expect(res.events.length).toBeGreaterThan(0);
      expect(res.cursorResetTo).toBeGreaterThan(1);
    });

    it("should prefer evicting noisy progress events before output", () => {
      const mgr = new SessionManager({ eventBufferMaxSize: 5, eventBufferHardMaxSize: 5 });
      try {
        mgr.create({ sessionId: "evict", cwd: "/tmp" });
        mgr.pushEvent("evict", {
          type: "output",
          data: { msg: "keep" },
          timestamp: new Date().toISOString(),
        });
        for (let i = 0; i < 10; i++) {
          mgr.pushEvent("evict", {
            type: "progress",
            data: { type: "task_progress", task_id: `t${i}`, usage: { total_tokens: i } },
            timestamp: new Date().toISOString(),
          });
        }

        const res = mgr.readEvents("evict");
        expect(res.events.length).toBeLessThanOrEqual(5);
        expect(res.events.some((e) => e.type === "output")).toBe(true);
      } finally {
        mgr.destroy();
      }
    });

    it("should track pending permission and resolve via finishRequest", () => {
      const ac = new AbortController();
      manager.create({ sessionId: "perm", cwd: "/tmp", abortController: ac });

      const finish = vi.fn();
      manager.setPendingPermission(
        "perm",
        {
          requestId: "r1",
          toolName: "Bash",
          input: { cmd: "echo hi" },
          summary: "Execute shell command",
          toolUseID: "tu1",
          createdAt: new Date().toISOString(),
        },
        finish,
        60_000
      );

      expect(manager.get("perm")!.status).toBe("waiting_permission");
      expect(manager.listPendingPermissions("perm")).toHaveLength(1);

      const ok = manager.finishRequest(
        "perm",
        "r1",
        { behavior: "allow", updatedInput: { cmd: "echo ok" } },
        "respond"
      );
      expect(ok).toBe(true);
      expect(finish).toHaveBeenCalledTimes(1);
      expect(manager.get("perm")!.status).toBe("running");
      expect(manager.getPendingPermissionCount("perm")).toBe(0);

      const permEvents = manager.readEvents("perm").events;
      const permResult = permEvents.find((e) => e.type === "permission_result");
      expect(permResult?.data).toMatchObject({
        requestId: "r1",
        toolName: "Bash",
        behavior: "allow",
        source: "respond",
      });

      expect(
        manager.finishRequest("perm", "r1", { behavior: "deny", message: "late" }, "respond")
      ).toBe(false);
    });

    it("should enforce disallowedTools even when respond_permission attempts to allow", () => {
      manager.create({ sessionId: "perm", cwd: "/tmp", disallowedTools: [" Bash "] });

      const finish = vi.fn();
      manager.setPendingPermission(
        "perm",
        {
          requestId: "r1",
          toolName: "Bash",
          input: { cmd: "echo hi" },
          summary: "Execute shell command",
          toolUseID: "tu1",
          createdAt: new Date().toISOString(),
        },
        finish,
        60_000
      );

      const ok = manager.finishRequest("perm", "r1", { behavior: "allow" }, "respond");
      expect(ok).toBe(true);
      expect(finish).toHaveBeenCalledTimes(1);
      expect(finish.mock.calls[0]?.[0]?.behavior).toBe("deny");
      expect(finish.mock.calls[0]?.[0]?.message).toContain("disallowed");

      const permEvents = manager.readEvents("perm").events;
      const permResult = permEvents.find((e) => e.type === "permission_result");
      expect((permResult?.data as { message?: string }).message).toContain("disallowed");
    });

    it("should allow adding tools for session-scoped auto-approval", () => {
      manager.create({ sessionId: "allow-session", cwd: "/tmp" });

      expect(manager.allowToolForSession("allow-session", "Read")).toBe(true);
      expect(manager.allowToolForSession("allow-session", "Read")).toBe(true);
      expect(manager.get("allow-session")?.allowedTools).toEqual(["Read"]);
    });

    it("should not add session-scoped allowed tool when disallowed", () => {
      manager.create({
        sessionId: "allow-session-deny",
        cwd: "/tmp",
        disallowedTools: [" Bash "],
      });

      expect(manager.allowToolForSession("allow-session-deny", "Bash")).toBe(false);
      expect(manager.get("allow-session-deny")?.allowedTools).toBeUndefined();
    });

    it("should default allow.updatedInput to the original tool input when omitted", () => {
      manager.create({ sessionId: "perm", cwd: "/tmp" });

      const finish = vi.fn();
      manager.setPendingPermission(
        "perm",
        {
          requestId: "r1",
          toolName: "Bash",
          input: { cmd: "echo hi" },
          summary: "Execute shell command",
          toolUseID: "tu1",
          createdAt: new Date().toISOString(),
        },
        finish,
        60_000
      );

      const ok = manager.finishRequest("perm", "r1", { behavior: "allow" }, "respond");
      expect(ok).toBe(true);
      expect(finish).toHaveBeenCalledTimes(1);
      expect(finish.mock.calls[0]?.[0]?.behavior).toBe("allow");
      expect((finish.mock.calls[0]?.[0] as { updatedInput?: unknown }).updatedInput).toEqual({
        cmd: "echo hi",
      });
    });

    it("should timeout pending permission requests", async () => {
      vi.useFakeTimers();
      try {
        manager.destroy();
        manager = new SessionManager();
        manager.create({ sessionId: "timeout", cwd: "/tmp" });
        const finish = vi.fn();
        manager.setPendingPermission(
          "timeout",
          {
            requestId: "r1",
            toolName: "Bash",
            input: { cmd: "echo hi" },
            summary: "Execute shell command",
            toolUseID: "tu1",
            createdAt: new Date().toISOString(),
          },
          finish,
          10
        );

        await vi.advanceTimersByTimeAsync(10);
        expect(finish).toHaveBeenCalledTimes(1);
        expect(manager.getPendingPermissionCount("timeout")).toBe(0);
        expect(manager.get("timeout")!.status).toBe("running");
      } finally {
        manager.destroy();
        vi.useRealTimers();
        manager = new SessionManager();
      }
    });

    it("should evict pinned permission events to keep buffer bounded", () => {
      manager.create({ sessionId: "pin", cwd: "/tmp" });
      // Only pinned events: permission_result is pinned by default.
      for (let i = 0; i < 1500; i++) {
        manager.pushEvent("pin", {
          type: "permission_result",
          data: { requestId: `r${i}`, behavior: "deny", source: "respond" },
          timestamp: new Date().toISOString(),
        });
      }

      const res = manager.readEvents("pin", 0);
      expect(res.events.length).toBeLessThanOrEqual(1000);
      expect(res.cursorResetTo).toBeGreaterThan(0);
    });

    it("should cancel waiting_permission sessions and deny pending requests", () => {
      const ac = new AbortController();
      manager.create({ sessionId: "cancel", cwd: "/tmp", abortController: ac });

      const finish = vi.fn();
      manager.setPendingPermission(
        "cancel",
        {
          requestId: "r1",
          toolName: "Bash",
          input: { cmd: "echo hi" },
          summary: "Execute shell command",
          toolUseID: "tu1",
          createdAt: new Date().toISOString(),
        },
        finish,
        60_000
      );

      expect(manager.cancel("cancel")).toBe(true);
      expect(ac.signal.aborted).toBe(true);
      expect(manager.get("cancel")!.status).toBe("cancelled");
      expect(finish).toHaveBeenCalledTimes(1);
      expect(finish.mock.calls[0]?.[0]?.behavior).toBe("deny");
    });

    it("should cap pending permissions per session", () => {
      manager.destroy();
      manager = new SessionManager({ maxPendingPermissionsPerSession: 2 });
      manager.create({ sessionId: "cap", cwd: "/tmp" });

      const finish = vi.fn();
      const ok1 = manager.setPendingPermission(
        "cap",
        {
          requestId: "r1",
          toolName: "Bash",
          input: { cmd: "echo 1" },
          summary: "s1",
          toolUseID: "tu1",
          createdAt: new Date().toISOString(),
        },
        finish,
        60_000
      );
      const ok2 = manager.setPendingPermission(
        "cap",
        {
          requestId: "r2",
          toolName: "Bash",
          input: { cmd: "echo 2" },
          summary: "s2",
          toolUseID: "tu2",
          createdAt: new Date().toISOString(),
        },
        finish,
        60_000
      );
      const ok3 = manager.setPendingPermission(
        "cap",
        {
          requestId: "r3",
          toolName: "Bash",
          input: { cmd: "echo 3" },
          summary: "s3",
          toolUseID: "tu3",
          createdAt: new Date().toISOString(),
        },
        finish,
        60_000
      );

      expect(ok1).toBe(true);
      expect(ok2).toBe(true);
      expect(ok3).toBe(false);
      expect(manager.getPendingPermissionCount("cap")).toBe(2);
      expect(finish).toHaveBeenCalledTimes(1);
      expect(finish.mock.calls[0]?.[0]).toMatchObject({ behavior: "deny" });
    });

    it("should reject new permission requests for terminal sessions", () => {
      const ac = new AbortController();
      manager.create({ sessionId: "term", cwd: "/tmp", abortController: ac });
      expect(manager.cancel("term")).toBe(true);

      const finish = vi.fn();
      const ok = manager.setPendingPermission(
        "term",
        {
          requestId: "r1",
          toolName: "Bash",
          input: { cmd: "echo hi" },
          summary: "s1",
          toolUseID: "tu1",
          createdAt: new Date().toISOString(),
        },
        finish,
        60_000
      );

      expect(ok).toBe(false);
      expect(manager.getPendingPermissionCount("term")).toBe(0);
      expect(manager.get("term")!.status).toBe("cancelled");
      expect(finish).toHaveBeenCalledTimes(1);
      expect(finish.mock.calls[0]?.[0]).toMatchObject({
        behavior: "deny",
        interrupt: true,
      });
    });

    it("should drain all pending requests even if finish callbacks try to enqueue more", () => {
      manager.create({ sessionId: "drain", cwd: "/tmp" });

      const finish2 = vi.fn();
      const finish1 = vi.fn(() => {
        manager.setPendingPermission(
          "drain",
          {
            requestId: "r2",
            toolName: "Bash",
            input: { cmd: "echo 2" },
            summary: "s2",
            toolUseID: "tu2",
            createdAt: new Date().toISOString(),
          },
          finish2,
          60_000
        );
      });

      manager.setPendingPermission(
        "drain",
        {
          requestId: "r1",
          toolName: "Bash",
          input: { cmd: "echo 1" },
          summary: "s1",
          toolUseID: "tu1",
          createdAt: new Date().toISOString(),
        },
        finish1,
        60_000
      );

      manager.finishAllPending(
        "drain",
        { behavior: "deny", message: "cleanup", interrupt: true },
        "cleanup"
      );

      expect(finish1).toHaveBeenCalledTimes(1);
      // Re-entrant setPendingPermission should be denied immediately while draining.
      expect(finish2).toHaveBeenCalledTimes(1);
      expect(finish2.mock.calls[0]?.[0]).toMatchObject({
        behavior: "deny",
        interrupt: true,
      });
      expect(manager.getPendingPermissionCount("drain")).toBe(0);
      expect(manager.get("drain")!.status).toBe("running");
    });
  });
});
