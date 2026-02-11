/**
 * Tests for claude_code and claude_code_reply tools
 * Uses mocked query() to simulate Agent SDK behavior
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { executeClaudeCode } from "../src/tools/claude-code.js";
import { executeClaudeCodeReply } from "../src/tools/claude-code-reply.js";

const mockQuery = vi.mocked(query);
type QueryReturn = ReturnType<typeof query>;

/** Helper to create an async generator from messages */
async function* fakeStream(messages: Record<string, unknown>[]) {
  for (const msg of messages) {
    yield msg;
  }
}

describe("executeClaudeCode", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("should handle a successful session", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "system",
          subtype: "init",
          session_id: "sess-123",
          uuid: "u1",
        },
        {
          type: "result",
          subtype: "success",
          result: "Fixed the bug!",
          duration_ms: 5000,
          num_turns: 3,
          total_cost_usd: 0.05,
          is_error: false,
          uuid: "u2",
          session_id: "sess-123",
        },
      ]) as QueryReturn
    );

    const result = await executeClaudeCode({ prompt: "Fix the bug" }, manager, "/tmp");

    expect(result.sessionId).toBe("sess-123");
    expect(result.result).toBe("Fixed the bug!");
    expect(result.isError).toBe(false);
    expect(result.durationMs).toBe(5000);
    expect(result.numTurns).toBe(3);
    expect(result.totalCostUsd).toBe(0.05);

    // Session should be tracked and idle
    const session = manager.get("sess-123");
    expect(session).toBeDefined();
    expect(session!.status).toBe("idle");
  });

  it("should handle error result from agent", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "system",
          subtype: "init",
          session_id: "sess-err",
          uuid: "u1",
        },
        {
          type: "result",
          subtype: "error_during_execution",
          errors: ["Something went wrong"],
          duration_ms: 1000,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: true,
          uuid: "u2",
          session_id: "sess-err",
        },
      ]) as QueryReturn
    );

    const result = await executeClaudeCode({ prompt: "Do something" }, manager, "/tmp");

    expect(result.isError).toBe(true);
    expect(result.result).toContain("Something went wrong");
    expect(manager.get("sess-err")!.status).toBe("error");
  });

  it("should handle non-string errors array", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "system",
          subtype: "init",
          session_id: "sess-nonstr",
          uuid: "u1",
        },
        {
          type: "result",
          subtype: "error_during_execution",
          errors: [{ message: "Oops" }, 123, null],
          duration_ms: 1000,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: true,
          uuid: "u2",
          session_id: "sess-nonstr",
        },
      ]) as QueryReturn
    );

    const result = await executeClaudeCode({ prompt: "Do something" }, manager, "/tmp");

    expect(result.isError).toBe(true);
    expect(result.result).toContain("[object Object]");
    expect(result.result).toContain("123");
    expect(result.result).toContain("null");
  });

  it("should handle thrown error from query()", async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-throw",
          uuid: "u1",
        };
        throw new Error("Network failure");
      })() as QueryReturn
    );

    const result = await executeClaudeCode({ prompt: "Do something" }, manager, "/tmp");

    expect(result.isError).toBe(true);
    expect(result.result).toContain("Network failure");
  });

  it("should handle missing init message", async () => {
    mockQuery.mockReturnValue(fakeStream([]) as QueryReturn);

    const result = await executeClaudeCode({ prompt: "Do something" }, manager, "/tmp");

    expect(result.isError).toBe(true);
    expect(result.sessionId).toBe("");
    expect(result.result).toContain("INTERNAL");
  });

  it("should reject empty cwd string", async () => {
    const result = await executeClaudeCode({ prompt: "Test", cwd: "" }, manager, "/tmp");
    expect(result.isError).toBe(true);
    expect(result.result).toContain("INVALID_ARGUMENT");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should timeout and abort query()", async () => {
    vi.useFakeTimers();
    try {
      mockQuery.mockImplementation(
        ({ options }: { options: { abortController: AbortController } }) => {
          const ac: AbortController = options.abortController;
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
            yield {
              type: "system",
              subtype: "init",
              session_id: "sess-timeout",
              uuid: "u1",
            };
            await abortPromise;
            yield; // unreachable, satisfies require-yield
          })();
        }
      );

      const resultPromise = executeClaudeCode({ prompt: "Test", timeout: 10 }, manager, "/tmp");
      await vi.advanceTimersByTimeAsync(10);
      const result = await resultPromise;

      expect(result.isError).toBe(true);
      expect(result.result).toContain("TIMEOUT");
      expect(manager.get("sess-timeout")!.status).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should return INTERNAL error when init received but no result message", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "system",
          subtype: "init",
          session_id: "sess-noresult",
          uuid: "u1",
        },
      ]) as QueryReturn
    );

    const result = await executeClaudeCode({ prompt: "Test" }, manager, "/tmp");

    expect(result.isError).toBe(true);
    expect(result.sessionId).toBe("sess-noresult");
    expect(result.result).toContain("INTERNAL");
    expect(result.result).toContain("No result message");
    expect(manager.get("sess-noresult")!.status).toBe("error");
  });

  it("should block bypassPermissions when not allowed", async () => {
    const result = await executeClaudeCode(
      { prompt: "Do something", permissionMode: "bypassPermissions" },
      manager,
      "/tmp",
      false
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain("PERMISSION_DENIED");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should allow bypassPermissions when explicitly enabled", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "system",
          subtype: "init",
          session_id: "sess-bypass",
          uuid: "u1",
        },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-bypass",
        },
      ]) as QueryReturn
    );

    const result = await executeClaudeCode(
      { prompt: "Do something", permissionMode: "bypassPermissions" },
      manager,
      "/tmp",
      true
    );

    expect(result.isError).toBe(false);
    expect(mockQuery).toHaveBeenCalled();
  });

  it("should return INTERNAL error when result arrives without init", async () => {
    // SDK yields a success result but never sends an init message
    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "result",
          subtype: "success",
          result: "Somehow succeeded",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u1",
          session_id: "ghost",
        },
      ]) as QueryReturn
    );

    const result = await executeClaudeCode({ prompt: "Do something" }, manager, "/tmp");

    // Should be an error because no session was created
    expect(result.isError).toBe(true);
    expect(result.sessionId).toBe("");
    expect(result.result).toContain("INTERNAL");
    // The original text should be preserved for debugging
    expect(result.result).toContain("Somehow succeeded");
  });

  it("should pass additionalDirectories to query options", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", subtype: "init", session_id: "sess-dirs", uuid: "u1" },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-dirs",
        },
      ]) as QueryReturn
    );

    await executeClaudeCode(
      { prompt: "Test", additionalDirectories: ["/extra/dir"] },
      manager,
      "/tmp"
    );

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ additionalDirectories: ["/extra/dir"] }),
      })
    );
  });

  it("should pass persistSession to query options", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", subtype: "init", session_id: "sess-persist", uuid: "u1" },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-persist",
        },
      ]) as QueryReturn
    );

    await executeClaudeCode({ prompt: "Test", persistSession: false }, manager, "/tmp");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ persistSession: false }),
      })
    );
  });

  it("should default permissionMode to dontAsk when not specified", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", subtype: "init", session_id: "sess-perm", uuid: "u1" },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-perm",
        },
      ]) as QueryReturn
    );

    await executeClaudeCode({ prompt: "Test" }, manager, "/tmp");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ permissionMode: "dontAsk" }),
      })
    );

    const session = manager.get("sess-perm");
    expect(session!.permissionMode).toBe("dontAsk");
  });

  it("should pass thinking option to query options", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", subtype: "init", session_id: "sess-think", uuid: "u1" },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-think",
        },
      ]) as QueryReturn
    );

    await executeClaudeCode(
      { prompt: "Test", thinking: { type: "enabled", budgetTokens: 5000 } },
      manager,
      "/tmp"
    );

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          thinking: { type: "enabled", budgetTokens: 5000 },
        }),
      })
    );
  });

  it("should pass outputFormat to query options", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", subtype: "init", session_id: "sess-fmt", uuid: "u1" },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-fmt",
        },
      ]) as QueryReturn
    );

    const fmt = { type: "json_schema" as const, schema: { type: "object" } };
    await executeClaudeCode({ prompt: "Test", outputFormat: fmt }, manager, "/tmp");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ outputFormat: fmt }),
      })
    );
  });

  it("should pass effort 'max' to query options", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", subtype: "init", session_id: "sess-max", uuid: "u1" },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-max",
        },
      ]) as QueryReturn
    );

    await executeClaudeCode({ prompt: "Test", effort: "max" }, manager, "/tmp");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ effort: "max" }),
      })
    );
  });

  it("should default settingSources to ['user', 'project', 'local'] when not specified", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", subtype: "init", session_id: "sess-ss-default", uuid: "u1" },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-ss-default",
        },
      ]) as QueryReturn
    );

    await executeClaudeCode({ prompt: "Test" }, manager, "/tmp");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          settingSources: ["user", "project", "local"],
        }),
      })
    );

    // Session should also store the resolved default
    const session = manager.get("sess-ss-default");
    expect(session!.settingSources).toEqual(["user", "project", "local"]);
  });

  it("should pass explicit settingSources (empty array) to query options", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", subtype: "init", session_id: "sess-ss-empty", uuid: "u1" },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-ss-empty",
        },
      ]) as QueryReturn
    );

    await executeClaudeCode({ prompt: "Test", settingSources: [] }, manager, "/tmp");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ settingSources: [] }),
      })
    );
  });

  it("should merge env with process.env when env is provided", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", subtype: "init", session_id: "sess-env-merge", uuid: "u1" },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-env-merge",
        },
      ]) as QueryReturn
    );

    await executeClaudeCode(
      { prompt: "Test", env: { CUSTOM_VAR: "custom_value" } },
      manager,
      "/tmp"
    );

    const callArgs = mockQuery.mock.calls[0]![0] as {
      options: { env?: Record<string, string | undefined> };
    };
    const passedEnv = callArgs.options.env!;
    // User-provided value should be present
    expect(passedEnv.CUSTOM_VAR).toBe("custom_value");
    // process.env values should also be present (PATH is always set)
    expect(passedEnv.PATH).toBe(process.env.PATH);
  });

  it("should not set options.env when env is not provided", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", subtype: "init", session_id: "sess-env-none", uuid: "u1" },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-env-none",
        },
      ]) as QueryReturn
    );

    await executeClaudeCode({ prompt: "Test" }, manager, "/tmp");

    const callArgs = mockQuery.mock.calls[0]![0] as {
      options: { env?: Record<string, string | undefined> };
    };
    expect(callArgs.options.env).toBeUndefined();
  });

  it("should clear abortController after completion", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "system",
          subtype: "init",
          session_id: "sess-ac",
          uuid: "u1",
        },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-ac",
        },
      ]) as QueryReturn
    );

    await executeClaudeCode({ prompt: "Test" }, manager, "/tmp");

    const session = manager.get("sess-ac");
    expect(session).toBeDefined();
    expect(session!.abortController).toBeUndefined();
  });

  it("should extract structuredOutput from successful result", async () => {
    mockQuery.mockReturnValue(
      fakeStream([
        { type: "system", subtype: "init", session_id: "sess-struct", uuid: "u1" },
        {
          type: "result",
          subtype: "success",
          result: "Done",
          structured_output: { answer: 42 },
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u2",
          session_id: "sess-struct",
        },
      ]) as QueryReturn
    );

    const result = await executeClaudeCode({ prompt: "Test" }, manager, "/tmp");

    expect(result.isError).toBe(false);
    expect(result.structuredOutput).toEqual({ answer: 42 });
  });
});

describe("executeClaudeCodeReply", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("should return error for non-existent session", async () => {
    const result = await executeClaudeCodeReply({ sessionId: "nope", prompt: "Continue" }, manager);
    expect(result.isError).toBe(true);
    expect(result.result).toContain("SESSION_NOT_FOUND");
  });

  it("should disk-resume when enabled and session is missing", async () => {
    const prev = process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME;
    process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME = "1";
    try {
      mockQuery.mockReturnValue(
        fakeStream([
          {
            type: "system",
            subtype: "init",
            session_id: "disk-sess",
            uuid: "u1",
            permissionMode: "dontAsk",
            cwd: "/project",
            tools: ["Read"],
            model: "claude-sonnet-4-5-20250929",
            apiKeySource: "env",
            claude_code_version: "2.1.38",
            mcp_servers: [],
            slash_commands: [],
            output_style: "default",
            skills: [],
            plugins: [],
            betas: [],
          },
          {
            type: "result",
            subtype: "success",
            result: "Resumed!",
            duration_ms: 100,
            num_turns: 1,
            total_cost_usd: 0.01,
            is_error: false,
            uuid: "u2",
            session_id: "disk-sess",
          },
        ]) as QueryReturn
      );

      const result = await executeClaudeCodeReply(
        { sessionId: "disk-sess", prompt: "Continue", cwd: "/tmp", persistSession: false },
        manager
      );

      expect(result.isError).toBe(false);
      expect(result.sessionId).toBe("disk-sess");
      expect(result.result).toBe("Resumed!");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            resume: "disk-sess",
            permissionMode: "dontAsk",
            persistSession: false,
          }),
        })
      );
      const session = manager.get("disk-sess");
      expect(session).toBeDefined();
      expect(session!.status).toBe("idle");
      // Updated from init message
      expect(session!.cwd).toBe("/project");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME;
      else process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME = prev;
    }
  });

  it("should disk-resume fork when enabled and session is missing", async () => {
    const prev = process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME;
    process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME = "1";
    try {
      mockQuery.mockReturnValue(
        fakeStream([
          {
            type: "system",
            subtype: "init",
            session_id: "disk-forked",
            uuid: "u1",
            permissionMode: "dontAsk",
            cwd: "/project",
            tools: ["Read"],
            model: "claude-sonnet-4-5-20250929",
            apiKeySource: "env",
            claude_code_version: "2.1.38",
            mcp_servers: [],
            slash_commands: [],
            output_style: "default",
            skills: [],
            plugins: [],
            betas: [],
          },
          {
            type: "result",
            subtype: "success",
            result: "Forked!",
            duration_ms: 100,
            num_turns: 1,
            total_cost_usd: 0.01,
            is_error: false,
            uuid: "u2",
            session_id: "disk-forked",
          },
        ]) as QueryReturn
      );

      const result = await executeClaudeCodeReply(
        { sessionId: "disk-orig", prompt: "Continue", forkSession: true },
        manager
      );

      expect(result.isError).toBe(false);
      expect(result.sessionId).toBe("disk-forked");
      expect(manager.get("disk-orig")).toBeUndefined();
      expect(manager.get("disk-forked")).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME;
      else process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME = prev;
    }
  });

  it("should return error for busy session", async () => {
    manager.create({ sessionId: "busy", cwd: "/tmp" });

    const result = await executeClaudeCodeReply({ sessionId: "busy", prompt: "Continue" }, manager);
    expect(result.isError).toBe(true);
    expect(result.result).toContain("SESSION_BUSY");
  });

  it("should reject cancelled session", async () => {
    manager.create({ sessionId: "cancelled-sess", cwd: "/tmp" });
    manager.cancel("cancelled-sess");

    const result = await executeClaudeCodeReply(
      { sessionId: "cancelled-sess", prompt: "Continue" },
      manager
    );
    expect(result.isError).toBe(true);
    expect(result.result).toContain("CANCELLED");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should reject resume of bypassPermissions session when bypass disabled", async () => {
    manager.create({
      sessionId: "bypass-sess",
      cwd: "/tmp",
      permissionMode: "bypassPermissions",
    });
    manager.update("bypass-sess", { status: "idle" });

    const result = await executeClaudeCodeReply(
      { sessionId: "bypass-sess", prompt: "Continue" },
      manager,
      false // allowBypass = false
    );
    expect(result.isError).toBe(true);
    expect(result.result).toContain("PERMISSION_DENIED");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("should allow resume of bypassPermissions session when bypass enabled", async () => {
    manager.create({
      sessionId: "bypass-ok",
      cwd: "/tmp",
      permissionMode: "bypassPermissions",
    });
    manager.update("bypass-ok", { status: "idle" });

    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u1",
          session_id: "bypass-ok",
        },
      ]) as QueryReturn
    );

    const result = await executeClaudeCodeReply(
      { sessionId: "bypass-ok", prompt: "Continue" },
      manager,
      true // allowBypass = true
    );
    expect(result.isError).toBe(false);
    expect(mockQuery).toHaveBeenCalled();
  });

  it("should continue an idle session", async () => {
    manager.create({ sessionId: "idle-sess", cwd: "/tmp" });
    manager.update("idle-sess", {
      status: "idle",
      totalTurns: 2,
      totalCostUsd: 0.03,
    });

    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "result",
          subtype: "success",
          result: "Tests added!",
          duration_ms: 3000,
          num_turns: 2,
          total_cost_usd: 0.04,
          is_error: false,
          uuid: "u2",
          session_id: "idle-sess",
        },
      ]) as QueryReturn
    );

    const result = await executeClaudeCodeReply(
      { sessionId: "idle-sess", prompt: "Add tests" },
      manager
    );

    expect(result.isError).toBe(false);
    expect(result.result).toBe("Tests added!");
    const session = manager.get("idle-sess");
    expect(session!.totalTurns).toBe(4);
    expect(session!.totalCostUsd).toBeCloseTo(0.07);
  });

  it("should pass persistSession to query options on reply", async () => {
    manager.create({ sessionId: "persist-reply", cwd: "/tmp", persistSession: false });
    manager.update("persist-reply", { status: "idle" });

    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u1",
          session_id: "persist-reply",
        },
      ]) as QueryReturn
    );

    await executeClaudeCodeReply({ sessionId: "persist-reply", prompt: "Continue" }, manager);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ persistSession: false }),
      })
    );
  });

  it("should default settingSources to ['user', 'project', 'local'] on reply", async () => {
    // Create session without explicit settingSources (simulating old session or undefined)
    manager.create({ sessionId: "ss-reply-default", cwd: "/tmp" });
    manager.update("ss-reply-default", { status: "idle" });

    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u1",
          session_id: "ss-reply-default",
        },
      ]) as QueryReturn
    );

    await executeClaudeCodeReply({ sessionId: "ss-reply-default", prompt: "Continue" }, manager);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          settingSources: ["user", "project", "local"],
        }),
      })
    );
  });

  it("should inherit custom settingSources from session on reply", async () => {
    manager.create({ sessionId: "ss-reply-custom", cwd: "/tmp", settingSources: ["user"] });
    manager.update("ss-reply-custom", { status: "idle" });

    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u1",
          session_id: "ss-reply-custom",
        },
      ]) as QueryReturn
    );

    await executeClaudeCodeReply({ sessionId: "ss-reply-custom", prompt: "Continue" }, manager);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ settingSources: ["user"] }),
      })
    );
  });

  it("should merge env with process.env on reply", async () => {
    manager.create({ sessionId: "env-reply", cwd: "/tmp", env: { MY_VAR: "hello" } });
    manager.update("env-reply", { status: "idle" });

    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "result",
          subtype: "success",
          result: "Done",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u1",
          session_id: "env-reply",
        },
      ]) as QueryReturn
    );

    await executeClaudeCodeReply({ sessionId: "env-reply", prompt: "Continue" }, manager);

    const callArgs = mockQuery.mock.calls[0]![0] as {
      options: { env?: Record<string, string | undefined> };
    };
    const passedEnv = callArgs.options.env!;
    expect(passedEnv.MY_VAR).toBe("hello");
    expect(passedEnv.PATH).toBe(process.env.PATH);
  });

  it("should handle fork correctly", async () => {
    manager.create({ sessionId: "orig", cwd: "/project" });
    manager.update("orig", {
      status: "idle",
      totalTurns: 5,
      totalCostUsd: 0.1,
    });

    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "system",
          subtype: "init",
          session_id: "forked-sess",
          uuid: "u1",
        },
        {
          type: "result",
          subtype: "success",
          result: "Forked work done",
          duration_ms: 2000,
          num_turns: 1,
          total_cost_usd: 0.02,
          is_error: false,
          uuid: "u2",
          session_id: "forked-sess",
        },
      ]) as QueryReturn
    );

    const result = await executeClaudeCodeReply(
      { sessionId: "orig", prompt: "Try alternative", forkSession: true },
      manager
    );

    expect(result.sessionId).toBe("forked-sess");
    expect(result.isError).toBe(false);

    // Original session unchanged
    const orig = manager.get("orig");
    expect(orig!.status).toBe("idle");
    expect(orig!.totalTurns).toBe(5);
    expect(orig!.totalCostUsd).toBe(0.1);

    // Forked session has only its own totals
    const forked = manager.get("forked-sess");
    expect(forked).toBeDefined();
    expect(forked!.totalTurns).toBe(1);
    expect(forked!.totalCostUsd).toBe(0.02);
  });

  it("should return error when fork requested but no new sessionId received", async () => {
    manager.create({ sessionId: "orig-nofork", cwd: "/tmp" });
    manager.update("orig-nofork", { status: "idle" });

    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "result",
          subtype: "success",
          result: "Done without fork",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u1",
          session_id: "orig-nofork",
        },
      ]) as QueryReturn
    );

    const result = await executeClaudeCodeReply(
      { sessionId: "orig-nofork", prompt: "Fork me", forkSession: true },
      manager
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain("INTERNAL");
    expect(result.result).toContain("Fork requested but no new session ID");
  });

  it("should allow reply to error status session", async () => {
    manager.create({ sessionId: "err-sess", cwd: "/tmp" });
    manager.update("err-sess", { status: "error" });

    mockQuery.mockReturnValue(
      fakeStream([
        {
          type: "result",
          subtype: "success",
          result: "Recovered",
          duration_ms: 100,
          num_turns: 1,
          total_cost_usd: 0.01,
          is_error: false,
          uuid: "u1",
          session_id: "err-sess",
        },
      ]) as QueryReturn
    );

    const result = await executeClaudeCodeReply(
      { sessionId: "err-sess", prompt: "Try again" },
      manager
    );

    expect(result.isError).toBe(false);
    expect(result.result).toBe("Recovered");
  });

  it("should timeout and abort reply query()", async () => {
    vi.useFakeTimers();
    try {
      manager.create({ sessionId: "reply-timeout", cwd: "/tmp" });
      manager.update("reply-timeout", { status: "idle" });

      mockQuery.mockImplementation(
        ({ options }: { options: { abortController: AbortController } }) => {
          const ac: AbortController = options.abortController;
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
            yield; // unreachable, satisfies require-yield
          })();
        }
      );

      const resultPromise = executeClaudeCodeReply(
        { sessionId: "reply-timeout", prompt: "Continue", timeout: 10 },
        manager
      );
      await vi.advanceTimersByTimeAsync(10);
      const result = await resultPromise;

      expect(result.isError).toBe(true);
      expect(result.result).toContain("TIMEOUT");
      expect(manager.get("reply-timeout")!.status).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should return TIMEOUT (not INTERNAL) when SDK ends stream silently after abort", async () => {
    vi.useFakeTimers();
    try {
      manager.create({ sessionId: "silent-abort", cwd: "/tmp" });
      manager.update("silent-abort", { status: "idle" });

      mockQuery.mockImplementation(
        ({ options }: { options: { abortController: AbortController } }) => {
          const ac: AbortController = options.abortController;
          // eslint-disable-next-line require-yield
          return (async function* () {
            // Wait for abort, then end stream silently (no throw, no result)
            await new Promise<void>((resolve) => {
              ac.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            // Stream ends without yielding a result or throwing
          })();
        }
      );

      const resultPromise = executeClaudeCodeReply(
        { sessionId: "silent-abort", prompt: "Continue", timeout: 10 },
        manager
      );
      await vi.advanceTimersByTimeAsync(10);
      const result = await resultPromise;

      expect(result.isError).toBe(true);
      expect(result.result).toContain("TIMEOUT");
      // Should NOT contain INTERNAL
      expect(result.result).not.toContain("INTERNAL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should reject fork of cancelled session", async () => {
    manager.create({ sessionId: "cancel-fork", cwd: "/tmp" });
    manager.cancel("cancel-fork");

    const result = await executeClaudeCodeReply(
      { sessionId: "cancel-fork", prompt: "Fork", forkSession: true },
      manager
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain("CANCELLED");
  });
  it("should preserve cancelled status in reply after cancellation", async () => {
    manager.create({ sessionId: "reply-cancel", cwd: "/tmp" });
    manager.update("reply-cancel", { status: "idle" });

    mockQuery.mockReturnValue(
      (async function* () {
        // Simulate cancel happening during reply execution
        manager.cancel("reply-cancel");
        throw new Error("AbortError: The operation was aborted");
        yield; // unreachable, satisfies require-yield
      })() as QueryReturn
    );

    await executeClaudeCodeReply({ sessionId: "reply-cancel", prompt: "Continue" }, manager);

    const session = manager.get("reply-cancel");
    expect(session).toBeDefined();
    expect(session!.status).toBe("cancelled");
  });

  it("should block disk-resume when init reports bypassPermissions and bypass is disabled", async () => {
    const prev = process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME;
    process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME = "1";
    try {
      mockQuery.mockReturnValue(
        fakeStream([
          {
            type: "system",
            subtype: "init",
            session_id: "disk-bypass",
            uuid: "u1",
            permissionMode: "bypassPermissions",
            cwd: "/project",
            tools: ["Read"],
            model: "claude-sonnet-4-5-20250929",
          },
          {
            type: "result",
            subtype: "success",
            result: "Should not reach here",
            duration_ms: 100,
            num_turns: 1,
            total_cost_usd: 0.01,
            is_error: false,
            uuid: "u2",
            session_id: "disk-bypass",
          },
        ]) as QueryReturn
      );

      const result = await executeClaudeCodeReply(
        { sessionId: "disk-bypass", prompt: "Continue", cwd: "/tmp" },
        manager,
        false // allowBypass = false
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("PERMISSION_DENIED");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME;
      else process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME = prev;
    }
  });

  it("should block disk-resume when input permissionMode is bypassPermissions and bypass is disabled", async () => {
    const prev = process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME;
    process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME = "1";
    try {
      const result = await executeClaudeCodeReply(
        {
          sessionId: "disk-bypass-input",
          prompt: "Continue",
          cwd: "/tmp",
          permissionMode: "bypassPermissions",
        },
        manager,
        false // allowBypass = false
      );

      expect(result.isError).toBe(true);
      expect(result.result).toContain("PERMISSION_DENIED");
      // query should not have been called at all
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME;
      else process.env.CLAUDE_CODE_MCP_ALLOW_DISK_RESUME = prev;
    }
  });
});

describe("cancellation semantics", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("should preserve cancelled status after execution completes", async () => {
    // Simulate: session is cancelled mid-execution, abort causes error
    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-cancel",
          uuid: "u1",
        };
        // Simulate cancel happening during execution
        manager.cancel("sess-cancel");
        // The abort causes an error
        throw new Error("AbortError: The operation was aborted");
        yield; // unreachable, satisfies require-yield
      })() as QueryReturn
    );

    await executeClaudeCode({ prompt: "Long task" }, manager, "/tmp");

    // Session should remain "cancelled", not be overwritten to "error"
    const session = manager.get("sess-cancel");
    expect(session).toBeDefined();
    expect(session!.status).toBe("cancelled");
  });

  it("should preserve original error when no init message received", async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        throw new Error("Authentication failed: invalid API key");
        yield; // unreachable, satisfies require-yield
      })() as QueryReturn
    );

    const result = await executeClaudeCode({ prompt: "Do something" }, manager, "/tmp");

    expect(result.isError).toBe(true);
    // Should contain both the INTERNAL error and the original error
    expect(result.result).toContain("INTERNAL");
    expect(result.result).toContain("Authentication failed");
  });
});
