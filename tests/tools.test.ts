/**
 * Tests for claude_code and claude_code_reply tools (v2 async behavior)
 * Uses mocked query() to simulate Agent SDK behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { SessionManager } from "../src/session/manager.js";

// Mock the Agent SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  class AbortError extends Error {
    constructor(message?: string) {
      super(message ?? "The operation was aborted");
      this.name = "AbortError";
    }
  }
  return {
    query: vi.fn(),
    AbortError,
  };
});

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { executeClaudeCode } from "../src/tools/claude-code.js";
import { executeClaudeCodeReply } from "../src/tools/claude-code-reply.js";
import { ToolDiscoveryCache } from "../src/tools/tool-discovery.js";
import { computeResumeToken } from "../src/utils/resume-token.js";

const mockQuery = vi.mocked(query);
type QueryReturn = ReturnType<typeof query>;
type QueryParams = Parameters<typeof query>[0];

async function waitUntil(fn: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("executeClaudeCode (async)", () => {
  let manager: SessionManager;
  let toolCache: ToolDiscoveryCache;

  beforeEach(() => {
    manager = new SessionManager();
    toolCache = new ToolDiscoveryCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("should return running session quickly and store the final result in SessionManager", async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "system",
          subtype: "status",
          status: null,
          uuid: "u0",
          session_id: "sess-123",
        };
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-123",
          uuid: "u1",
          cwd: "/tmp",
          tools: ["Read", "Write"],
          claude_code_version: "x",
          model: "m",
          permissionMode: "default",
          apiKeySource: "env",
          mcp_servers: [],
          slash_commands: [],
          output_style: "",
          skills: [],
          plugins: [],
        };
        yield {
          type: "result",
          subtype: "success",
          result: "Fixed the bug!",
          duration_ms: 5,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-123",
          duration_api_ms: 5,
          stop_reason: null,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          structured_output: { ok: true },
        };
      })() as unknown as QueryReturn
    );

    const start = await executeClaudeCode({ prompt: "Fix the bug" }, manager, "/tmp", toolCache);

    expect(start.status).toBe("running");
    expect(start.sessionId).toBe("sess-123");
    if (start.status === "running") {
      expect(start.pollInterval).toBe(3000);
    }

    await waitUntil(() => manager.get("sess-123")?.status === "idle");
    expect(manager.get("sess-123")!.status).toBe("idle");

    const stored = manager.getResult("sess-123");
    expect(stored?.type).toBe("result");
    expect(stored?.result.result).toBe("Fixed the bug!");
  });

  it("should return an error when session limit is reached", async () => {
    manager = new SessionManager({ maxSessions: 1 });
    manager.create({
      sessionId: "sess-existing",
      cwd: "/tmp",
      permissionMode: "default",
    });
    const start = await executeClaudeCode({ prompt: "Fix the bug" }, manager, "/tmp", toolCache);
    expect(start.status).toBe("error");
    expect((start as { error?: string }).error).toContain("RESOURCE_EXHAUSTED");
  });

  it("should pass option fields through to query()", async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-opts",
          uuid: "u1",
          cwd: "/tmp",
          tools: ["Read"],
          claude_code_version: "x",
          model: "m",
          permissionMode: "default",
          apiKeySource: "env",
          mcp_servers: [],
          slash_commands: [],
          output_style: "",
          skills: [],
          plugins: [],
        };
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          is_error: false,
          uuid: "u2",
          session_id: "sess-opts",
          duration_api_ms: 1,
          stop_reason: null,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        };
      })() as unknown as QueryReturn
    );

    await executeClaudeCode(
      {
        prompt: "Test",
        effort: "max",
        thinking: { type: "adaptive" },
        advanced: {
          additionalDirectories: ["/extra"],
          persistSession: false,
          outputFormat: { type: "json_schema", schema: { type: "object" } },
          // Deprecated aliases should not override top-level.
          effort: "low",
          thinking: { type: "disabled" },
          env: { TEST_ENV: "1" },
        },
      },
      manager,
      "/tmp",
      toolCache
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(call.options.additionalDirectories).toEqual(["/extra"]);
    expect(call.options.persistSession).toBe(false);
    expect(call.options.thinking).toEqual({ type: "adaptive" });
    expect(call.options.outputFormat).toEqual({ type: "json_schema", schema: { type: "object" } });
    expect(call.options.effort).toBe("max");
    expect(call.options.permissionMode).toBe("default");
    expect(typeof call.options.canUseTool).toBe("function");
    expect((call.options.env as Record<string, unknown>).TEST_ENV).toBe("1");
  });

  it("should return error on invalid cwd", async () => {
    const start = await executeClaudeCode({ prompt: "Test", cwd: "" }, manager, "/tmp", toolCache);
    expect(start.status).toBe("error");
    if (start.status === "error") {
      expect(start.error).toContain("INVALID_ARGUMENT");
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should return error when explicit cwd does not exist", async () => {
    const missingCwd = path.join(process.cwd(), `.missing-cwd-${Date.now()}-${Math.random()}`);
    expect(existsSync(missingCwd)).toBe(false);

    const start = await executeClaudeCode(
      { prompt: "Test", cwd: missingCwd },
      manager,
      "/tmp",
      toolCache
    );
    expect(start.status).toBe("error");
    if (start.status === "error") {
      expect(start.error).toContain("INVALID_ARGUMENT");
      expect(start.error).toContain("path does not exist");
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should return TIMEOUT when init is not received within sessionInitTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      mockQuery.mockImplementation((params: QueryParams): QueryReturn => {
        const ac = (params.options as unknown as { abortController: AbortController })
          .abortController;
        return (async function* () {
          const abortPromise = new Promise<void>((_resolve, reject) => {
            ac.signal.addEventListener(
              "abort",
              () => {
                const e = new Error("The operation was aborted");
                e.name = "AbortError";
                reject(e);
              },
              { once: true }
            );
          });
          await abortPromise;
          yield; // unreachable
        })() as unknown as QueryReturn;
      });

      const promise = executeClaudeCode(
        { prompt: "Test", advanced: { sessionInitTimeoutMs: 10 } },
        manager,
        "/tmp",
        toolCache
      );
      await vi.advanceTimersByTimeAsync(10);
      const start = await promise;
      expect(start.status).toBe("error");
      if (start.status === "error") {
        expect(start.error).toContain("TIMEOUT");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("should support top-level sessionInitTimeoutMs as a compatibility alias", async () => {
    vi.useFakeTimers();
    try {
      mockQuery.mockImplementation((params: QueryParams): QueryReturn => {
        const ac = (params.options as unknown as { abortController: AbortController })
          .abortController;
        return (async function* () {
          const abortPromise = new Promise<void>((_resolve, reject) => {
            ac.signal.addEventListener(
              "abort",
              () => {
                const e = new Error("The operation was aborted");
                e.name = "AbortError";
                reject(e);
              },
              { once: true }
            );
          });
          await abortPromise;
          yield; // unreachable
        })() as unknown as QueryReturn;
      });

      const promise = executeClaudeCode(
        { prompt: "Test", sessionInitTimeoutMs: 10 },
        manager,
        "/tmp",
        toolCache
      );
      await vi.advanceTimersByTimeAsync(10);
      const start = await promise;
      expect(start.status).toBe("error");
      if (start.status === "error") {
        expect(start.error).toContain("TIMEOUT");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("should prefer advanced.sessionInitTimeoutMs when both timeout fields are provided", async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-timeout-compat",
          uuid: "u1",
          cwd: "/tmp",
          tools: ["Read"],
          claude_code_version: "x",
          model: "m",
          permissionMode: "default",
          apiKeySource: "env",
          mcp_servers: [],
          slash_commands: [],
          output_style: "",
          skills: [],
          plugins: [],
        };
      })() as unknown as QueryReturn
    );

    const start = await executeClaudeCode(
      { prompt: "Test", sessionInitTimeoutMs: 5000, advanced: { sessionInitTimeoutMs: 1000 } },
      manager,
      "/tmp",
      toolCache
    );

    expect(start.status).toBe("running");
    if (start.status === "running") {
      expect(start.compatWarnings).toContain(
        "Top-level sessionInitTimeoutMs for claude_code is a compatibility alias; prefer advanced.sessionInitTimeoutMs."
      );
      expect(start.compatWarnings).toContain(
        "Both advanced.sessionInitTimeoutMs (1000) and top-level sessionInitTimeoutMs (5000) were provided; using advanced.sessionInitTimeoutMs."
      );
    }
  });

  it("should return CANCELLED when the MCP tool call is cancelled before init", async () => {
    mockQuery.mockImplementation((params: QueryParams): QueryReturn => {
      const ac = (params.options as unknown as { abortController: AbortController })
        .abortController;
      return (async function* () {
        const abortPromise = new Promise<void>((_resolve, reject) => {
          ac.signal.addEventListener(
            "abort",
            () => {
              const e = new Error("The operation was aborted");
              e.name = "AbortError";
              reject(e);
            },
            { once: true }
          );
        });
        await abortPromise;
        yield; // unreachable
      })() as unknown as QueryReturn;
    });

    const request = new AbortController();
    const promise = executeClaudeCode(
      { prompt: "Test", advanced: { sessionInitTimeoutMs: 10_000 } },
      manager,
      "/tmp",
      toolCache,
      request.signal
    );
    request.abort();

    const start = await promise;
    expect(start.status).toBe("error");
    if (start.status === "error") {
      expect(start.error).toContain("CANCELLED");
    }
  });

  it("should surface permission requests via SessionManager and continue after finishRequest", async () => {
    mockQuery.mockImplementation((params: QueryParams): QueryReturn => {
      const options = params.options as unknown as { canUseTool: CanUseTool };
      return (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-perm",
          uuid: "u1",
          cwd: "/tmp",
          tools: ["Bash"],
          claude_code_version: "x",
          model: "m",
          permissionMode: "default",
          apiKeySource: "env",
          mcp_servers: [],
          slash_commands: [],
          output_style: "",
          skills: [],
          plugins: [],
        };

        await options.canUseTool(
          "Bash",
          { cmd: "echo hi" },
          {
            signal: new AbortController().signal,
            toolUseID: "tu1",
            decisionReason: "needs permission",
          }
        );

        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          is_error: false,
          uuid: "u2",
          session_id: "sess-perm",
          duration_api_ms: 1,
          stop_reason: null,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        };
      })() as unknown as QueryReturn;
    });

    const start = await executeClaudeCode({ prompt: "Test" }, manager, "/tmp", toolCache);
    expect(start.sessionId).toBe("sess-perm");

    await waitUntil(() => manager.get("sess-perm")?.status === "waiting_permission");
    const pending = manager.listPendingPermissions("sess-perm");
    expect(pending).toHaveLength(1);

    manager.finishRequest("sess-perm", pending[0]!.requestId, { behavior: "allow" }, "respond");

    await waitUntil(() => manager.get("sess-perm")?.status === "idle");
    expect(manager.get("sess-perm")!.status).toBe("idle");
  });
});

describe("executeClaudeCodeReply (async)", () => {
  let manager: SessionManager;
  let toolCache: ToolDiscoveryCache;

  beforeEach(() => {
    manager = new SessionManager();
    toolCache = new ToolDiscoveryCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("should keep only the latest terminal result event across multiple replies", async () => {
    manager.create({ sessionId: "sess-multi", cwd: "/tmp", permissionMode: "default" });
    manager.update("sess-multi", { status: "idle" });
    manager.pushEvent("sess-multi", {
      type: "result",
      data: { sessionId: "sess-multi", result: "first", isError: false },
      timestamp: new Date().toISOString(),
    });

    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "second",
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          is_error: false,
          uuid: "u3",
          session_id: "sess-multi",
          duration_api_ms: 1,
          stop_reason: null,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        };
      })() as unknown as QueryReturn
    );

    const reply = await executeClaudeCodeReply(
      { sessionId: "sess-multi", prompt: "reply" },
      manager,
      toolCache
    );
    expect(reply.status).toBe("running");

    await waitUntil(() => manager.get("sess-multi")?.status === "idle");
    const events = manager.readEvents("sess-multi", 0).events;
    const terminalCount = events.filter((e) => e.type === "result" || e.type === "error").length;
    expect(terminalCount).toBe(1);
    expect((manager.getResult("sess-multi")?.result.result as string) ?? "").toBe("second");
  });

  it("should return error for missing session when disk resume is disabled", async () => {
    const res = await executeClaudeCodeReply(
      { sessionId: "nope", prompt: "Hi" },
      manager,
      toolCache
    );
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.error).toContain("SESSION_NOT_FOUND");
    }
  });

  it("should disk-resume when enabled and session is missing", async () => {
    vi.stubEnv("CLAUDE_CODE_MCP_ALLOW_DISK_RESUME", "1");
    vi.stubEnv("CLAUDE_CODE_MCP_RESUME_SECRET", "test-secret");
    try {
      mockQuery.mockReturnValue(
        (async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: "ok",
            duration_ms: 1,
            num_turns: 1,
            total_cost_usd: 0,
            is_error: false,
            uuid: "u2",
            session_id: "disk-1",
            duration_api_ms: 1,
            stop_reason: null,
            usage: {},
            modelUsage: {},
            permission_denials: [],
          };
        })() as unknown as QueryReturn
      );

      const res = await executeClaudeCodeReply(
        {
          sessionId: "disk-1",
          prompt: "Hi",
          diskResumeConfig: {
            cwd: "/tmp",
            resumeToken: computeResumeToken("disk-1", "test-secret"),
          },
        },
        manager,
        toolCache
      );
      expect(res.status).toBe("running");
      expect(manager.get("disk-1")).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("should reject disk resume when resumeToken is missing", async () => {
    vi.stubEnv("CLAUDE_CODE_MCP_ALLOW_DISK_RESUME", "1");
    vi.stubEnv("CLAUDE_CODE_MCP_RESUME_SECRET", "test-secret");
    try {
      const res = await executeClaudeCodeReply(
        { sessionId: "disk-1", prompt: "Hi", diskResumeConfig: { cwd: "/tmp" } },
        manager,
        toolCache
      );
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error).toContain("PERMISSION_DENIED");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("should reject disk resume when resumeToken is invalid", async () => {
    vi.stubEnv("CLAUDE_CODE_MCP_ALLOW_DISK_RESUME", "1");
    vi.stubEnv("CLAUDE_CODE_MCP_RESUME_SECRET", "test-secret");
    try {
      const res = await executeClaudeCodeReply(
        {
          sessionId: "disk-1",
          prompt: "Hi",
          diskResumeConfig: { cwd: "/tmp", resumeToken: "bad" },
        },
        manager,
        toolCache
      );
      expect(res.status).toBe("error");
      if (res.status === "error") {
        expect(res.error).toContain("PERMISSION_DENIED");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("should return error for busy sessions", async () => {
    manager.create({ sessionId: "busy", cwd: "/tmp" });
    manager.update("busy", { status: "running" });
    const res = await executeClaudeCodeReply(
      { sessionId: "busy", prompt: "Hi" },
      manager,
      toolCache
    );
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.error).toContain("SESSION_BUSY");
    }
  });

  it("should resume an idle session", async () => {
    manager.create({ sessionId: "idle", cwd: "/tmp" });
    manager.update("idle", { status: "idle" });

    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          is_error: false,
          uuid: "u2",
          session_id: "idle",
          duration_api_ms: 1,
          stop_reason: null,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        };
      })() as unknown as QueryReturn
    );

    const res = await executeClaudeCodeReply(
      { sessionId: "idle", prompt: "Hi" },
      manager,
      toolCache
    );
    expect(res.status).toBe("running");
    await waitUntil(() => manager.get("idle")?.status === "idle");
    expect(manager.get("idle")!.status).toBe("idle");
  });

  it("should pass effort/thinking overrides to query() and persist them on non-fork replies", async () => {
    manager.create({
      sessionId: "idle-opts",
      cwd: "/tmp",
      permissionMode: "default",
      effort: "low",
      thinking: { type: "disabled" },
    });
    manager.update("idle-opts", { status: "idle" });

    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          is_error: false,
          uuid: "u2",
          session_id: "idle-opts",
          duration_api_ms: 1,
          stop_reason: null,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        };
      })() as unknown as QueryReturn
    );

    const res = await executeClaudeCodeReply(
      {
        sessionId: "idle-opts",
        prompt: "Hi",
        effort: "max",
        thinking: { type: "adaptive" },
      },
      manager,
      toolCache
    );
    expect(res.status).toBe("running");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(call.options.effort).toBe("max");
    expect(call.options.thinking).toEqual({ type: "adaptive" });

    expect(manager.get("idle-opts")!.effort).toBe("max");
    expect(manager.get("idle-opts")!.thinking).toEqual({ type: "adaptive" });
  });

  it("should handle fork by returning the new sessionId and keeping the original idle", async () => {
    manager.create({
      sessionId: "orig",
      cwd: "/tmp",
      permissionMode: "default",
      effort: "low",
      thinking: { type: "disabled" },
    });
    manager.update("orig", { status: "idle" });

    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "forked",
          uuid: "u1",
          cwd: "/tmp",
          tools: ["Read"],
          claude_code_version: "x",
          model: "m",
          permissionMode: "default",
          apiKeySource: "env",
          mcp_servers: [],
          slash_commands: [],
          output_style: "",
          skills: [],
          plugins: [],
        };
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          is_error: false,
          uuid: "u2",
          session_id: "forked",
          duration_api_ms: 1,
          stop_reason: null,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        };
      })() as unknown as QueryReturn
    );

    const res = await executeClaudeCodeReply(
      {
        sessionId: "orig",
        prompt: "Hi",
        forkSession: true,
        sessionInitTimeoutMs: 1000,
        effort: "max",
        thinking: { type: "adaptive" },
      },
      manager,
      toolCache
    );
    expect(res.status).toBe("running");
    expect(res.sessionId).toBe("forked");

    expect(manager.get("orig")!.status).toBe("idle");
    expect(manager.get("orig")!.effort).toBe("low");
    expect(manager.get("orig")!.thinking).toEqual({ type: "disabled" });
    expect(manager.get("forked")).toBeDefined();
    expect(manager.get("forked")!.effort).toBe("max");
    expect(manager.get("forked")!.thinking).toEqual({ type: "adaptive" });

    await waitUntil(() => manager.get("forked")?.status === "idle");
  });

  it("should return INTERNAL error when fork requested but no new sessionId is received", async () => {
    manager.create({ sessionId: "orig", cwd: "/tmp" });
    manager.update("orig", { status: "idle" });

    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "orig",
          uuid: "u1",
          cwd: "/tmp",
          tools: ["Read"],
          claude_code_version: "x",
          model: "m",
          permissionMode: "default",
          apiKeySource: "env",
          mcp_servers: [],
          slash_commands: [],
          output_style: "",
          skills: [],
          plugins: [],
        };
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          is_error: false,
          uuid: "u2",
          session_id: "orig",
          duration_api_ms: 1,
          stop_reason: null,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        };
      })() as unknown as QueryReturn
    );

    const res = await executeClaudeCodeReply(
      { sessionId: "orig", prompt: "Hi", forkSession: true, sessionInitTimeoutMs: 1000 },
      manager,
      toolCache
    );
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.error).toContain("INTERNAL");
    }
  });
});
