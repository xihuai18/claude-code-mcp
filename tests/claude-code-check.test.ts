import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager } from "../src/session/manager.js";
import { ToolDiscoveryCache } from "../src/tools/tool-discovery.js";
import { executeClaudeCodeCheck } from "../src/tools/claude-code-check.js";
import type { CheckResult, PermissionRequestRecord } from "../src/types.js";

describe("executeClaudeCodeCheck", () => {
  let manager: SessionManager;
  let toolCache: ToolDiscoveryCache;

  beforeEach(() => {
    manager = new SessionManager();
    toolCache = new ToolDiscoveryCache();
  });

  afterEach(() => {
    manager.destroy();
    vi.clearAllMocks();
  });

  it("should return SESSION_NOT_FOUND for missing session", () => {
    const res = executeClaudeCodeCheck({ action: "poll", sessionId: "nope" }, manager, toolCache);
    expect("isError" in res && res.isError).toBe(true);
    expect((res as { error: string }).error).toContain("SESSION_NOT_FOUND");
  });

  it("should omit availableTools when includeTools=true but init tools are not available yet", () => {
    manager.create({ sessionId: "s1", cwd: "/tmp" });
    manager.update("s1", { status: "idle" });

    const res = executeClaudeCodeCheck(
      { action: "poll", sessionId: "s1", includeTools: true },
      manager,
      toolCache
    );

    expect("isError" in res).toBe(false);
    expect((res as { availableTools?: unknown[] }).availableTools).toBeUndefined();
  });

  it("should reflect init tools when includeTools=true (no catalog extras)", () => {
    manager.create({ sessionId: "s1", cwd: "/tmp" });
    manager.setInitTools("s1", ["Read"]);
    manager.update("s1", { status: "idle" });

    const res = executeClaudeCodeCheck(
      { action: "poll", sessionId: "s1", includeTools: true },
      manager,
      toolCache
    ) as CheckResult;

    expect(res.availableTools?.map((t) => t.name)).toEqual(["Read"]);
  });

  it("should surface pending permission requests and allow respond_permission", () => {
    manager.create({ sessionId: "s1", cwd: "/tmp" });

    const finish = vi.fn();
    manager.setPendingPermission(
      "s1",
      {
        requestId: "r1",
        toolName: "Bash",
        input: { cmd: "echo hi" },
        summary: "Execute shell",
        toolUseID: "tu1",
        createdAt: new Date().toISOString(),
      },
      finish,
      60_000
    );

    const polled = executeClaudeCodeCheck({ action: "poll", sessionId: "s1" }, manager, toolCache);
    expect("isError" in polled).toBe(false);
    expect((polled as { status: string }).status).toBe("waiting_permission");
    expect((polled as { actions?: unknown[] }).actions?.length).toBe(1);

    const responded = executeClaudeCodeCheck(
      {
        action: "respond_permission",
        sessionId: "s1",
        requestId: "r1",
        decision: "allow",
        updatedInput: { cmd: "echo ok" },
        updatedPermissions: [{ scope: "test" }],
      },
      manager,
      toolCache
    );
    expect("isError" in responded).toBe(false);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0]?.[0]?.behavior).toBe("allow");
    expect(finish.mock.calls[0]?.[0]?.updatedInput).toEqual({ cmd: "echo ok" });
    expect(Array.isArray(finish.mock.calls[0]?.[0]?.updatedPermissions)).toBe(true);
    expect(manager.getPendingPermissionCount("s1")).toBe(0);
  });

  it("should map deny decisions with denyMessage and interrupt", () => {
    manager.create({ sessionId: "s1", cwd: "/tmp" });

    const finish = vi.fn();
    manager.setPendingPermission(
      "s1",
      {
        requestId: "r1",
        toolName: "Bash",
        input: { cmd: "echo hi" },
        summary: "Execute shell",
        toolUseID: "tu1",
        createdAt: new Date().toISOString(),
      },
      finish,
      60_000
    );

    const responded = executeClaudeCodeCheck(
      {
        action: "respond_permission",
        sessionId: "s1",
        requestId: "r1",
        decision: "deny",
        denyMessage: "nope",
        interrupt: true,
      },
      manager,
      toolCache
    );

    expect("isError" in responded).toBe(false);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0]?.[0]).toEqual({
      behavior: "deny",
      message: "nope",
      interrupt: true,
    });
  });

  it("should return PERMISSION_REQUEST_NOT_FOUND for unknown requestId", () => {
    manager.create({ sessionId: "s1", cwd: "/tmp" });
    manager.update("s1", { status: "waiting_permission" });

    const res = executeClaudeCodeCheck(
      { action: "respond_permission", sessionId: "s1", requestId: "nope", decision: "allow" },
      manager,
      toolCache
    );
    expect("isError" in res && res.isError).toBe(true);
    expect((res as { error: string }).error).toContain("PERMISSION_REQUEST_NOT_FOUND");
  });

  it("exposes the full permission record through check actions", () => {
    manager.create({ sessionId: "s1", cwd: "/tmp" });

    const record: PermissionRequestRecord = {
      requestId: "full",
      toolName: "Bash",
      input: { cmd: "echo hi" },
      summary: "Run shell",
      decisionReason: "blocked by policy",
      blockedPath: "/tmp",
      toolUseID: "tu-full",
      agentID: "agent-x",
      suggestions: [{ scope: "s1" }],
      description: "Detailed description",
      createdAt: new Date().toISOString(),
    };

    manager.setPendingPermission("s1", record, vi.fn(), 60_000);
    const polled = executeClaudeCodeCheck(
      { action: "poll", sessionId: "s1" },
      manager,
      toolCache
    ) as CheckResult;

    expect(polled.actions).toHaveLength(1);
    expect(polled.actions?.[0]).toMatchObject({
      type: "permission",
      requestId: "full",
      toolName: "Bash",
      input: { cmd: "echo hi" },
      summary: "Run shell",
      decisionReason: "blocked by policy",
      blockedPath: "/tmp",
      toolUseID: "tu-full",
      agentID: "agent-x",
      suggestions: [{ scope: "s1" }],
      description: "Detailed description",
      createdAt: record.createdAt,
    });
  });

  it("supports concurrent permission requests and keeps waiting_state until all resolved", () => {
    manager.create({ sessionId: "s1", cwd: "/tmp" });
    const finishFirst = vi.fn();
    const finishSecond = vi.fn();

    manager.setPendingPermission(
      "s1",
      {
        requestId: "r1",
        toolName: "Bash",
        input: { cmd: "echo one" },
        summary: "First",
        toolUseID: "tu1",
        createdAt: "2025-01-01T00:00:00.000Z",
      },
      finishFirst,
      60_000
    );
    manager.setPendingPermission(
      "s1",
      {
        requestId: "r2",
        toolName: "Bash",
        input: { cmd: "echo two" },
        summary: "Second",
        toolUseID: "tu2",
        createdAt: "2025-01-01T00:00:01.000Z",
      },
      finishSecond,
      60_000
    );

    const initial = executeClaudeCodeCheck(
      { action: "poll", sessionId: "s1" },
      manager,
      toolCache
    ) as CheckResult;
    expect(initial.status).toBe("waiting_permission");
    expect(initial.actions?.map((a) => a.requestId)).toEqual(["r1", "r2"]);

    const responded = executeClaudeCodeCheck(
      { action: "respond_permission", sessionId: "s1", requestId: "r1", decision: "allow" },
      manager,
      toolCache
    ) as CheckResult;
    expect(responded.status).toBe("waiting_permission");
    expect(responded.actions?.map((a) => a.requestId)).toEqual(["r2"]);
    expect(finishFirst).toHaveBeenCalledTimes(1);
    expect(finishSecond).not.toHaveBeenCalled();
  });

  it("surfaces timeout-denied permissions in poll events", async () => {
    manager.create({ sessionId: "s1", cwd: "/tmp" });
    const finish = vi.fn();

    const record = {
      requestId: "timeout",
      toolName: "Bash",
      input: { cmd: "sleep" },
      summary: "Timeout test",
      toolUseID: "tu-timeout",
      createdAt: new Date().toISOString(),
    };

    vi.useFakeTimers();
    try {
      manager.setPendingPermission("s1", record, finish, 10);
      await vi.advanceTimersByTimeAsync(20);
    } finally {
      vi.useRealTimers();
    }

    const polled = executeClaudeCodeCheck(
      { action: "poll", sessionId: "s1" },
      manager,
      toolCache
    ) as CheckResult;
    expect(polled.status).toBe("running");
    expect(polled.actions).toBeUndefined();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(polled.events.some((e) => e.type === "permission_result")).toBe(true);
  });

  it("denies pending permissions when the session is cancelled", () => {
    manager.create({ sessionId: "s1", cwd: "/tmp" });
    const finish = vi.fn();

    manager.setPendingPermission(
      "s1",
      {
        requestId: "cancel-now",
        toolName: "Bash",
        input: { cmd: "exit" },
        summary: "Cancel test",
        toolUseID: "tu-cancel",
        createdAt: new Date().toISOString(),
      },
      finish,
      60_000
    );

    expect(manager.cancel("s1")).toBe(true);

    const polled = executeClaudeCodeCheck(
      { action: "poll", sessionId: "s1" },
      manager,
      toolCache
    ) as CheckResult;
    expect(polled.status).toBe("cancelled");
    expect(polled.actions).toBeUndefined();
    expect(finish).toHaveBeenCalledTimes(1);
    const resultEvent = polled.events.find((event) => event.type === "permission_result");
    expect(resultEvent).toBeDefined();
    expect((resultEvent?.data as { behavior: string; source: string }).behavior).toBe("deny");
    expect((resultEvent?.data as { behavior: string; source: string }).source).toBe("cancel");
  });

  it("defaults to minimal mode (redacts usage/modelUsage and avoids duplicate terminal events)", () => {
    manager.create({ sessionId: "s1", cwd: "/tmp" });

    const agentResult = {
      sessionId: "s1",
      result: "ok",
      isError: false,
      durationMs: 1,
      numTurns: 1,
      totalCostUsd: 0.01,
      usage: { input_tokens: 123, output_tokens: 456 },
      modelUsage: { cache_read_input_tokens: 789 },
      structuredOutput: { hello: "world" },
    };

    manager.setResult("s1", {
      type: "result",
      result: agentResult,
      createdAt: new Date().toISOString(),
    });
    manager.clearTerminalEvents("s1");
    manager.pushEvent("s1", {
      type: "result",
      data: agentResult,
      timestamp: new Date().toISOString(),
    });
    manager.update("s1", { status: "idle" });

    const polled = executeClaudeCodeCheck(
      { action: "poll", sessionId: "s1" },
      manager,
      toolCache
    ) as CheckResult;

    expect(polled.status).toBe("idle");
    expect(polled.result).toBeDefined();
    expect((polled.result as { usage?: unknown }).usage).toBeUndefined();
    expect((polled.result as { modelUsage?: unknown }).modelUsage).toBeUndefined();
    expect((polled.result as { structuredOutput?: unknown }).structuredOutput).toBeUndefined();
    expect(polled.events.some((e) => e.type === "result")).toBe(false);
  });

  it("supports full mode to include usage/modelUsage and terminal events", () => {
    manager.create({ sessionId: "s1", cwd: "/tmp" });

    const agentResult = {
      sessionId: "s1",
      result: "ok",
      isError: false,
      durationMs: 1,
      numTurns: 1,
      totalCostUsd: 0.01,
      usage: { input_tokens: 1 },
      modelUsage: { cache_read_input_tokens: 2 },
      structuredOutput: { x: 1 },
    };

    manager.setResult("s1", {
      type: "result",
      result: agentResult,
      createdAt: new Date().toISOString(),
    });
    manager.clearTerminalEvents("s1");
    manager.pushEvent("s1", {
      type: "result",
      data: agentResult,
      timestamp: new Date().toISOString(),
    });
    manager.update("s1", { status: "idle" });

    const polled = executeClaudeCodeCheck(
      { action: "poll", sessionId: "s1", responseMode: "full" },
      manager,
      toolCache
    ) as CheckResult;

    expect((polled.result as { usage?: unknown }).usage).toEqual({ input_tokens: 1 });
    expect((polled.result as { modelUsage?: unknown }).modelUsage).toEqual({
      cache_read_input_tokens: 2,
    });
    expect((polled.result as { structuredOutput?: unknown }).structuredOutput).toEqual({ x: 1 });
    expect(polled.events.some((e) => e.type === "result")).toBe(true);
  });

  it("supports maxEvents pagination and marks events as truncated", () => {
    manager.create({ sessionId: "s1", cwd: "/tmp" });

    for (let i = 0; i < 5; i++) {
      manager.pushEvent("s1", {
        type: "progress",
        data: { type: "status", idx: i },
        timestamp: new Date().toISOString(),
      });
    }

    const first = executeClaudeCodeCheck(
      { action: "poll", sessionId: "s1", maxEvents: 2 },
      manager,
      toolCache
    ) as CheckResult;
    expect(first.truncated).toBe(true);
    expect(first.truncatedFields).toEqual(["events"]);
    expect(first.events).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const second = executeClaudeCodeCheck(
      { action: "poll", sessionId: "s1", cursor: first.nextCursor as number },
      manager,
      toolCache
    ) as CheckResult;
    expect(second.events.length).toBeGreaterThan(0);
    expect(second.events.some((e) => (e.data as { idx?: number }).idx === 0)).toBe(false);
  });
});
