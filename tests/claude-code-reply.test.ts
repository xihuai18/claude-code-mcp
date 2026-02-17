import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
import { SessionManager } from "../src/session/manager.js";
import { executeClaudeCodeReply } from "../src/tools/claude-code-reply.js";
import { ToolDiscoveryCache } from "../src/tools/tool-discovery.js";
import { computeResumeToken } from "../src/utils/resume-token.js";

const mockQuery = vi.mocked(query);

function successStream(sessionId: string): ReturnType<typeof query> {
  return (async function* () {
    yield {
      type: "result",
      subtype: "success",
      result: "ok",
      duration_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      is_error: false,
      uuid: "u1",
      session_id: sessionId,
      duration_api_ms: 1,
      stop_reason: null,
      usage: {},
      modelUsage: {},
      permission_denials: [],
    };
  })() as unknown as ReturnType<typeof query>;
}

describe("claude-code-reply", () => {
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

  it("resumes an idle session and returns running immediately", async () => {
    manager.create({ sessionId: "sess-1", cwd: "/tmp" });
    manager.update("sess-1", { status: "idle" });
    mockQuery.mockReturnValue(successStream("sess-1"));

    const result = await executeClaudeCodeReply(
      { sessionId: "sess-1", prompt: "continue" },
      manager,
      toolCache
    );

    expect(result.status).toBe("running");
  });

  it("rejects replies for cancelled sessions", async () => {
    manager.create({ sessionId: "sess-2", cwd: "/tmp" });
    manager.update("sess-2", { status: "cancelled" });

    const result = await executeClaudeCodeReply(
      { sessionId: "sess-2", prompt: "continue" },
      manager,
      toolCache
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("CANCELLED");
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects fork when session capacity is full", async () => {
    manager.destroy();
    manager = new SessionManager({ maxSessions: 1 });
    manager.create({ sessionId: "sess-3", cwd: "/tmp" });
    manager.update("sess-3", { status: "idle" });

    const result = await executeClaudeCodeReply(
      { sessionId: "sess-3", prompt: "fork", forkSession: true },
      manager,
      toolCache
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("RESOURCE_EXHAUSTED");
    }
  });

  it("rejects disk resume when cwd path does not exist", async () => {
    vi.stubEnv("CLAUDE_CODE_MCP_ALLOW_DISK_RESUME", "1");
    vi.stubEnv("CLAUDE_CODE_MCP_RESUME_SECRET", "test-secret");
    try {
      const missingCwd = path.join(process.cwd(), `.missing-reply-cwd-${Date.now()}`);
      const result = await executeClaudeCodeReply(
        {
          sessionId: "missing-reply",
          prompt: "continue",
          diskResumeConfig: {
            cwd: missingCwd,
            resumeToken: computeResumeToken("missing-reply", "test-secret"),
          },
        },
        manager,
        toolCache
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toContain("INVALID_ARGUMENT");
        expect(result.error).toContain("path does not exist");
      }
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("maps /tmp/* session cwd to the OS temp directory on Windows", async () => {
    if (process.platform !== "win32") return;

    const createdDir = mkdtempSync(path.join(os.tmpdir(), "cc-reply-cwd-"));
    const posixLikeCwd = `/tmp/${path.basename(createdDir)}`;
    try {
      manager.create({ sessionId: "sess-win-tmp", cwd: posixLikeCwd });
      manager.update("sess-win-tmp", { status: "idle" });
      mockQuery.mockReturnValue(successStream("sess-win-tmp"));

      const result = await executeClaudeCodeReply(
        { sessionId: "sess-win-tmp", prompt: "continue" },
        manager,
        toolCache
      );

      expect(result.status).toBe("running");
    } finally {
      rmSync(createdDir, { recursive: true, force: true });
    }
  });
});
