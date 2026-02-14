import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionManager } from "../src/session/manager.js";
import { ToolDiscoveryCache } from "../src/tools/tool-discovery.js";

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

import { query, AbortError } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { consumeQuery, classifyError } from "../src/tools/query-consumer.js";

const mockQuery = vi.mocked(query);
type QueryReturn = ReturnType<typeof query>;

describe("consumeQuery", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should resolve sessionId from system/init even when init is not the first message", async () => {
    const manager = new SessionManager();
    const toolCache = new ToolDiscoveryCache();
    const abortController = new AbortController();

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
          session_id: "sess-123",
          duration_api_ms: 1,
          stop_reason: null,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        };
      })() as QueryReturn
    );

    const handle = consumeQuery({
      mode: "start",
      prompt: "test",
      abortController,
      options: { cwd: "/tmp" },
      permissionRequestTimeoutMs: 60_000,
      sessionInitTimeoutMs: 10_000,
      sessionManager: manager,
      toolCache,
      onInit: (init) => {
        manager.create({
          sessionId: init.session_id,
          cwd: init.cwd,
          permissionMode: "default",
          abortController,
        });
      },
    });

    const sessionId = await handle.sdkSessionIdPromise;
    expect(sessionId).toBe("sess-123");

    await handle.done;
    expect(manager.get("sess-123")!.status).toBe("idle");

    const events = manager.readEvents("sess-123").events;
    expect(events.some((e) => e.type === "progress")).toBe(true);

    manager.destroy();
  });

  it("should block on canUseTool until finishRequest resolves", async () => {
    const manager = new SessionManager();
    const toolCache = new ToolDiscoveryCache();
    const abortController = new AbortController();

    mockQuery.mockImplementation(({ options }: { options: { canUseTool: CanUseTool } }) => {
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
      })();
    });

    const handle = consumeQuery({
      mode: "start",
      prompt: "test",
      abortController,
      options: { cwd: "/tmp" },
      permissionRequestTimeoutMs: 60_000,
      sessionInitTimeoutMs: 10_000,
      sessionManager: manager,
      toolCache,
      onInit: (init) => {
        manager.create({
          sessionId: init.session_id,
          cwd: init.cwd,
          permissionMode: "default",
          abortController,
        });
      },
    });

    const sessionId = await handle.sdkSessionIdPromise;
    expect(sessionId).toBe("sess-perm");

    // canUseTool is now waiting for caller decision
    for (let i = 0; i < 20; i++) {
      if (manager.get("sess-perm")!.status === "waiting_permission") break;
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(manager.get("sess-perm")!.status).toBe("waiting_permission");
    const pending = manager.listPendingPermissions("sess-perm");
    expect(pending).toHaveLength(1);

    const requestId = pending[0]!.requestId;
    manager.finishRequest("sess-perm", requestId, { behavior: "allow" }, "respond");

    await handle.done;
    expect(manager.get("sess-perm")!.status).toBe("idle");

    manager.destroy();
  });

  it("should buffer pre-init events when waitForInitSessionId=true (fork-like resume)", async () => {
    const manager = new SessionManager();
    const toolCache = new ToolDiscoveryCache();
    const abortController = new AbortController();

    manager.create({
      sessionId: "orig",
      cwd: "/tmp",
      permissionMode: "default",
    });
    manager.update("orig", { status: "idle", abortController: undefined });

    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "system",
          subtype: "status",
          status: null,
          uuid: "u0",
        };
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
      })() as QueryReturn
    );

    const handle = consumeQuery({
      mode: "resume",
      sessionId: "orig",
      prompt: "test",
      abortController,
      options: { cwd: "/tmp", forkSession: true },
      permissionRequestTimeoutMs: 60_000,
      sessionInitTimeoutMs: 10_000,
      waitForInitSessionId: true,
      sessionManager: manager,
      toolCache,
      onInit: (init) => {
        manager.create({
          sessionId: init.session_id,
          cwd: init.cwd,
          permissionMode: "default",
          abortController,
        });
      },
    });

    const newSessionId = await handle.sdkSessionIdPromise;
    expect(newSessionId).toBe("forked");

    await handle.done;

    expect(manager.readEvents("orig").events).toHaveLength(0);
    expect(manager.readEvents("forked").events.some((e) => e.type === "progress")).toBe(true);

    manager.destroy();
  });
});

// --- M7: Error path tests ---

describe("classifyError", () => {
  it("should classify AbortError as abort", () => {
    const signal = new AbortController().signal;
    expect(classifyError(new AbortError(), signal)).toBe("abort");
  });

  it("should classify aborted signal as abort even for non-AbortError", () => {
    const ac = new AbortController();
    ac.abort();
    expect(classifyError(new Error("something"), ac.signal)).toBe("abort");
  });

  it("should classify ECONNRESET as transient", () => {
    const signal = new AbortController().signal;
    expect(classifyError(new Error("read ECONNRESET"), signal)).toBe("transient");
  });

  it("should classify ETIMEDOUT as transient", () => {
    const signal = new AbortController().signal;
    expect(classifyError(new Error("connect ETIMEDOUT"), signal)).toBe("transient");
  });

  it("should classify ECONNREFUSED as transient", () => {
    const signal = new AbortController().signal;
    expect(classifyError(new Error("connect ECONNREFUSED 127.0.0.1:443"), signal)).toBe(
      "transient"
    );
  });

  it("should classify ENOTFOUND as transient", () => {
    const signal = new AbortController().signal;
    expect(classifyError(new Error("getaddrinfo ENOTFOUND api.example.com"), signal)).toBe(
      "transient"
    );
  });

  it("should classify EAI_AGAIN as transient", () => {
    const signal = new AbortController().signal;
    expect(classifyError(new Error("getaddrinfo EAI_AGAIN api.example.com"), signal)).toBe(
      "transient"
    );
  });

  it("should classify unknown errors as fatal", () => {
    const signal = new AbortController().signal;
    expect(classifyError(new Error("authentication failed"), signal)).toBe("fatal");
  });
});

describe("consumeQuery error paths", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should mark session as error when stream throws a fatal error", async () => {
    const manager = new SessionManager();
    const toolCache = new ToolDiscoveryCache();
    const abortController = new AbortController();

    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-fatal",
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
        throw new Error("authentication failed");
      })() as QueryReturn
    );

    const handle = consumeQuery({
      mode: "start",
      prompt: "test",
      abortController,
      options: { cwd: "/tmp" },
      permissionRequestTimeoutMs: 60_000,
      sessionInitTimeoutMs: 10_000,
      sessionManager: manager,
      toolCache,
      onInit: (init) => {
        manager.create({
          sessionId: init.session_id,
          cwd: init.cwd,
          permissionMode: "default",
          abortController,
        });
      },
    });

    await handle.sdkSessionIdPromise;
    await handle.done;

    const session = manager.get("sess-fatal");
    expect(session).toBeDefined();
    expect(session!.status).toBe("error");

    const result = manager.getResult("sess-fatal");
    expect(result).toBeDefined();
    expect(result!.result.isError).toBe(true);

    manager.destroy();
  });

  it("should mark session as error when stream ends without result (missing_result)", async () => {
    const manager = new SessionManager();
    const toolCache = new ToolDiscoveryCache();
    const abortController = new AbortController();

    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-noresult",
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
          type: "assistant",
          message: { role: "assistant", content: "hello" },
          uuid: "u2",
          session_id: "sess-noresult",
        };
        // Stream ends without a result message
      })() as QueryReturn
    );

    const handle = consumeQuery({
      mode: "start",
      prompt: "test",
      abortController,
      options: { cwd: "/tmp" },
      permissionRequestTimeoutMs: 60_000,
      sessionInitTimeoutMs: 10_000,
      sessionManager: manager,
      toolCache,
      onInit: (init) => {
        manager.create({
          sessionId: init.session_id,
          cwd: init.cwd,
          permissionMode: "default",
          abortController,
        });
      },
    });

    await handle.sdkSessionIdPromise;
    await handle.done;

    const session = manager.get("sess-noresult");
    expect(session!.status).toBe("error");

    const result = manager.getResult("sess-noresult");
    expect(result!.result.result).toContain("No result message received");

    manager.destroy();
  });

  it("should retry on transient error and succeed on second attempt", async () => {
    const manager = new SessionManager();
    const toolCache = new ToolDiscoveryCache();
    const abortController = new AbortController();
    let callCount = 0;

    mockQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: init then transient error
        return (async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "sess-retry",
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
          throw new Error("read ECONNRESET");
        })();
      }
      // Second call (resume retry): success
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "ok after retry",
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          is_error: false,
          uuid: "u2",
          session_id: "sess-retry",
          duration_api_ms: 1,
          stop_reason: null,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        };
      })();
    });

    const handle = consumeQuery({
      mode: "start",
      prompt: "test",
      abortController,
      options: { cwd: "/tmp" },
      permissionRequestTimeoutMs: 60_000,
      sessionInitTimeoutMs: 10_000,
      sessionManager: manager,
      toolCache,
      onInit: (init) => {
        if (!manager.get(init.session_id)) {
          manager.create({
            sessionId: init.session_id,
            cwd: init.cwd,
            permissionMode: "default",
            abortController,
          });
        }
      },
    });

    await handle.sdkSessionIdPromise;
    await handle.done;

    expect(callCount).toBe(2);
    const session = manager.get("sess-retry");
    expect(session!.status).toBe("idle");

    // Should have a retry progress event
    const events = manager.readEvents("sess-retry").events;
    const retryEvent = events.find(
      (e) => e.type === "progress" && (e.data as { type?: string })?.type === "retry"
    );
    expect(retryEvent).toBeDefined();

    manager.destroy();
  });

  it("should resolve canUseTool immediately when signal is already aborted (M1 fix)", async () => {
    const manager = new SessionManager();
    const toolCache = new ToolDiscoveryCache();
    const abortController = new AbortController();

    // Pre-abort the signal that will be passed to canUseTool
    const preAbortedAc = new AbortController();
    preAbortedAc.abort();

    mockQuery.mockImplementation(({ options }: { options: { canUseTool: CanUseTool } }) => {
      return (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-preabort",
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

        // Call canUseTool with an already-aborted signal
        const result = await options.canUseTool(
          "Bash",
          { cmd: "echo hi" },
          {
            signal: preAbortedAc.signal,
            toolUseID: "tu1",
          }
        );
        // Should get a deny result immediately (not after 60s timeout)
        expect(result.behavior).toBe("deny");

        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          is_error: false,
          uuid: "u2",
          session_id: "sess-preabort",
          duration_api_ms: 1,
          stop_reason: null,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        };
      })();
    });

    const handle = consumeQuery({
      mode: "start",
      prompt: "test",
      abortController,
      options: { cwd: "/tmp" },
      permissionRequestTimeoutMs: 60_000,
      sessionInitTimeoutMs: 10_000,
      sessionManager: manager,
      toolCache,
      onInit: (init) => {
        manager.create({
          sessionId: init.session_id,
          cwd: init.cwd,
          permissionMode: "default",
          abortController,
        });
      },
    });

    await handle.sdkSessionIdPromise;
    await handle.done;

    const session = manager.get("sess-preabort");
    expect(session!.status).toBe("idle");

    manager.destroy();
  });
});
