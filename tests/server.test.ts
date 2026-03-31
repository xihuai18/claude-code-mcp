import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, createServerContext } from "../src/server.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

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

const mockQuery = vi.mocked(query);

describe("MCP Server", () => {
  it("should create a server instance", () => {
    const server = createServer("/tmp");
    expect(server).toBeDefined();
  });

  it("should have the correct server name", () => {
    const server = createServer("/tmp");
    // The server should be an McpServer instance
    expect(server).toHaveProperty("tool");
    expect(server).toHaveProperty("connect");
    expect(server).toHaveProperty("close");
  });

  it("should return structuredContent for tool results", async () => {
    const server = createServer("/tmp");
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const res = await client.callTool({
        name: "claude_code_session",
        arguments: { action: "list" },
      });
      expect(res).toHaveProperty("structuredContent");
      expect(res.structuredContent).toHaveProperty("sessions");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should expose tool annotations in tools/list", async () => {
    const server = createServer("/tmp");
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const claudeCode = listed.tools.find((t) => t.name === "claude_code");
      expect(claudeCode).toBeDefined();
      expect(claudeCode?.annotations).toBeDefined();
      expect(claudeCode?.annotations?.openWorldHint).toBe(true);
      expect(claudeCode?.annotations?.destructiveHint).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should expose model-visible reminders in tool descriptions", async () => {
    const server = createServer("/tmp");
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const claudeCode = listed.tools.find((t) => t.name === "claude_code");
      const claudeCodeReply = listed.tools.find((t) => t.name === "claude_code_reply");
      const claudeCodeCheck = listed.tools.find((t) => t.name === "claude_code_check");
      const claudeCodePrompt = claudeCode?.inputSchema?.properties?.prompt as
        | { description?: string }
        | undefined;
      const claudeCodeReplySessionId = claudeCodeReply?.inputSchema?.properties?.sessionId as
        | { description?: string }
        | undefined;
      const claudeCodeEffort = claudeCode?.inputSchema?.properties?.effort as
        | { description?: string }
        | undefined;
      const claudeCodeThinking = claudeCode?.inputSchema?.properties?.thinking as
        | { description?: string }
        | undefined;
      const claudeCodeAllowedTools = claudeCode?.inputSchema?.properties?.allowedTools as
        | { description?: string }
        | undefined;
      const claudeCodeStrictAllowedTools = claudeCode?.inputSchema?.properties
        ?.strictAllowedTools as { description?: string } | undefined;
      const claudeCodeCheckAction = claudeCodeCheck?.inputSchema?.properties?.action as
        | { description?: string }
        | undefined;
      const claudeCodeCheckResponseMode = claudeCodeCheck?.inputSchema?.properties?.responseMode as
        | { description?: string }
        | undefined;
      const claudeCodeAdvanced = claudeCode?.inputSchema?.properties?.advanced as
        | { properties?: Record<string, { description?: string }> }
        | undefined;
      const replyDiskResumeConfig = claudeCodeReply?.inputSchema?.properties?.diskResumeConfig as
        | { properties?: Record<string, { description?: string }> }
        | undefined;

      expect(claudeCode?.description).toContain("10+ minutes");
      expect(claudeCode?.description).toContain("No final result is returned here");
      expect(claudeCode?.description).toContain("respond_user_input is not supported");
      expect(claudeCodePrompt?.description).toContain(
        "final result arrives later via claude_code_check"
      );
      expect(claudeCodePrompt?.description).toContain("Store nextCursor");
      expect(claudeCodeReply?.description).toContain("same sessionId");
      expect(claudeCodeReply?.description).toContain(
        "Use diskResumeConfig only when the in-memory session is missing"
      );
      expect(claudeCodeReplySessionId?.description).toContain("persistent sessions");
      expect(claudeCodeEffort?.description).toContain("Effort string");
      expect(claudeCodeThinking?.description).toContain("Thinking config object, not a string");
      expect(claudeCodeThinking?.description).toContain("budgetTokens?:N");
      expect(claudeCodeAllowedTools?.description).toContain("not a strict allowlist");
      expect(claudeCodeStrictAllowedTools?.description).toContain(
        "tools outside allowedTools are denied"
      );
      expect(claudeCodeAdvanced?.properties?.tools?.description).toContain(
        "Visible built-in tool set"
      );
      expect(claudeCodeAdvanced?.properties?.settings?.description).toContain(
        "highest-priority flag settings"
      );
      expect(claudeCodeAdvanced?.properties?.sandbox?.description).toContain(
        "not the actual allow/deny permission rules"
      );
      expect(claudeCodeAdvanced?.properties?.toolConfig?.description).toContain("askUserQuestion");
      expect(replyDiskResumeConfig?.properties?.thinking?.description).toContain(
        "Thinking config object, not a string"
      );
      expect(claudeCodeCheck?.description).toContain("persist nextCursor");
      expect(claudeCodeCheck?.description).toContain("respond_user_input is not supported");
      expect(claudeCodeCheckAction?.description).toContain(
        "'poll' fetches new events/actions/result"
      );
      expect(claudeCodeCheckResponseMode?.description).toContain("high-frequency polling");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should keep claude_code advanced schema at 24 low-frequency fields", async () => {
    const server = createServer("/tmp");
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const claudeCode = listed.tools.find((t) => t.name === "claude_code") as
        | {
            inputSchema?: {
              properties?: {
                advanced?: {
                  properties?: Record<string, unknown>;
                };
              };
            };
          }
        | undefined;
      expect(claudeCode).toBeDefined();
      const topLevelProps = claudeCode?.inputSchema?.properties ?? {};
      expect(topLevelProps).not.toHaveProperty("sessionInitTimeoutMs");
      const advancedProps = claudeCode?.inputSchema?.properties?.advanced?.properties ?? {};
      const keys = Object.keys(advancedProps);
      expect(keys).toHaveLength(24);
      expect(keys).not.toContain("effort");
      expect(keys).not.toContain("thinking");
      expect(keys).toContain("promptSuggestions");
      expect(keys).toContain("toolConfig");
      expect(keys).toContain("agentProgressSummaries");
      expect(keys).toContain("settings");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should declare capabilities consistent with exposed primitives", async () => {
    const server = createServer("/tmp");
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const caps = client.getServerCapabilities();
      expect(caps).toBeDefined();
      expect(caps?.logging).toBeDefined();
      expect(caps?.tools).toBeDefined();
      expect(caps?.resources).toBeDefined();
      expect(caps?.prompts).toBeUndefined();
      expect(caps?.completions).toBeUndefined();
      expect(caps?.tasks).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should expose interrupt and allow_for_session in tool schemas", async () => {
    const server = createServer("/tmp");
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const sessionTool = listed.tools.find((t) => t.name === "claude_code_session") as
        | {
            inputSchema?: {
              properties?: {
                action?: { enum?: unknown[] };
              };
            };
          }
        | undefined;
      const checkTool = listed.tools.find((t) => t.name === "claude_code_check") as
        | {
            inputSchema?: {
              properties?: {
                decision?: { enum?: unknown[] };
              };
            };
          }
        | undefined;

      expect(sessionTool?.inputSchema?.properties?.action?.enum).toContain("interrupt");
      expect(checkTool?.inputSchema?.properties?.decision?.enum).toContain("allow_for_session");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should expose strictAllowedTools in claude_code and diskResumeConfig schemas", async () => {
    const server = createServer("/tmp");
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const claudeCode = listed.tools.find((t) => t.name === "claude_code") as
        | { inputSchema?: { properties?: Record<string, unknown> } }
        | undefined;
      const claudeCodeReply = listed.tools.find((t) => t.name === "claude_code_reply") as
        | {
            inputSchema?: {
              properties?: {
                diskResumeConfig?: {
                  properties?: Record<string, unknown>;
                };
              };
            };
          }
        | undefined;

      expect(
        (claudeCode?.inputSchema?.properties?.strictAllowedTools as { type?: string } | undefined)
          ?.type
      ).toBe("boolean");
      expect(
        (
          claudeCodeReply?.inputSchema?.properties?.diskResumeConfig?.properties
            ?.strictAllowedTools as { type?: string } | undefined
        )?.type
      ).toBe("boolean");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should support claude_code_session(action='interrupt') via MCP tool call", async () => {
    const ctx = createServerContext("/tmp");
    const { server, sessionManager } = ctx;
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      sessionManager.create({ sessionId: "sess-interrupt", cwd: "/tmp" });

      const res = await client.callTool({
        name: "claude_code_session",
        arguments: { action: "interrupt", sessionId: "sess-interrupt" },
      });
      const normalized = res as {
        content?: Array<{ type?: string; text?: string }>;
        structuredContent?: unknown;
        isError?: boolean;
      };
      const textPayload =
        normalized.content?.[0] && typeof normalized.content[0].text === "string"
          ? normalized.content[0].text
          : undefined;
      const parsedText =
        typeof textPayload === "string"
          ? (() => {
              try {
                return JSON.parse(textPayload) as unknown;
              } catch {
                return undefined;
              }
            })()
          : undefined;
      const payload = (normalized.structuredContent ?? parsedText) as
        | { message?: string; sessions?: Array<{ status?: string }> }
        | undefined;

      expect(normalized.isError).toBeFalsy();
      expect(payload?.message).toContain("interrupted");
      expect(payload?.sessions?.[0]?.status).toBe("running");
    } finally {
      await client.close();
      sessionManager.destroy();
      await server.close();
    }
  });

  it("should invoke claude_code via MCP tool call with minimal input", async () => {
    type QueryReturn = ReturnType<typeof query>;
    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-mcp-call",
          uuid: "u-init",
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
          result: "ok",
          duration_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          is_error: false,
          uuid: "u-res",
          session_id: "sess-mcp-call",
          duration_api_ms: 1,
          stop_reason: null,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        };
      })() as unknown as QueryReturn
    );

    const server = createServer("/tmp");
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const res = await client.callTool({
        name: "claude_code",
        arguments: { prompt: "say hi" },
      });
      const normalized = res as {
        content?: Array<{ type?: string; text?: string }>;
        structuredContent?: unknown;
        isError?: boolean;
      };
      const textPayload =
        normalized.content?.[0] && typeof normalized.content[0].text === "string"
          ? normalized.content[0].text
          : undefined;
      const parsedText =
        typeof textPayload === "string"
          ? (() => {
              try {
                return JSON.parse(textPayload) as unknown;
              } catch {
                return undefined;
              }
            })()
          : undefined;
      const payload = (normalized.structuredContent ?? parsedText) as
        | {
            sessionId?: string;
            status?: string;
            error?: string;
          }
        | undefined;
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(payload).toBeDefined();
      expect(normalized.isError).toBeFalsy();
      const data = payload as {
        sessionId?: string;
        status?: string;
        error?: string;
      };
      expect(data.error).toBeUndefined();
      expect(data.status).toBe("running");
      expect(data.sessionId).toBe("sess-mcp-call");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("should accept thinking={type:'enabled'} without budgetTokens via MCP schema", async () => {
    type QueryReturn = ReturnType<typeof query>;
    mockQuery.mockClear();
    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-thinking-enabled",
          uuid: "u-init-thinking-enabled",
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
          uuid: "u-res-thinking-enabled",
          session_id: "sess-thinking-enabled",
          duration_api_ms: 1,
          stop_reason: null,
          usage: {},
          modelUsage: {},
          permission_denials: [],
        };
      })() as unknown as QueryReturn
    );

    const server = createServer("/tmp");
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const res = await client.callTool({
        name: "claude_code",
        arguments: { prompt: "say hi", thinking: { type: "enabled" } },
      });

      const normalized = res as {
        structuredContent?: unknown;
        content?: Array<{ text?: unknown }>;
      };
      const payload =
        normalized.structuredContent && typeof normalized.structuredContent === "object"
          ? (normalized.structuredContent as { status?: string; sessionId?: string })
          : (JSON.parse(String(normalized.content?.[0]?.text ?? "{}")) as {
              status?: string;
              sessionId?: string;
            });

      expect(payload.status).toBe("running");
      expect(payload.sessionId).toBe("sess-thinking-enabled");
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1]?.[0] as {
        options?: { thinking?: unknown };
      };
      expect(call.options?.thinking).toEqual({ type: "enabled" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps MCP tools callable after cancel then poll", async () => {
    type QueryReturn = ReturnType<typeof query>;
    mockQuery.mockImplementationOnce((params) => {
      const ac = (params.options as { abortController?: AbortController }).abortController;
      return (async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "sess-cancel-regression",
          uuid: "u-init-cancel",
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
        await new Promise<void>((resolve) => {
          if (!ac || ac.signal.aborted) {
            resolve();
            return;
          }
          ac.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })() as unknown as QueryReturn;
    });

    const parsePayload = (
      res: Awaited<ReturnType<Client["callTool"]>>
    ): {
      sessionId?: string;
      status?: string;
      sessions?: Array<{ status?: string }>;
      [k: string]: unknown;
    } => {
      const normalized = res as {
        structuredContent?: unknown;
        content?: Array<{ text?: unknown }>;
      };
      if (normalized.structuredContent && typeof normalized.structuredContent === "object") {
        return normalized.structuredContent as {
          sessionId?: string;
          status?: string;
          sessions?: Array<{ status?: string }>;
          [k: string]: unknown;
        };
      }
      const first = Array.isArray(normalized.content) ? normalized.content[0] : undefined;
      const text = typeof first?.text === "string" ? first.text : "{}";
      return JSON.parse(text) as {
        sessionId?: string;
        status?: string;
        sessions?: Array<{ status?: string }>;
        [k: string]: unknown;
      };
    };

    const server = createServer("/tmp");
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const start = parsePayload(
        await client.callTool({
          name: "claude_code",
          arguments: {
            prompt: "wait for cancellation",
            maxTurns: 3,
            advanced: { sessionInitTimeoutMs: 5000 },
          },
        })
      );
      expect(start.status).toBe("running");
      expect(start.sessionId).toBe("sess-cancel-regression");

      const cancel = parsePayload(
        await client.callTool({
          name: "claude_code_session",
          arguments: { action: "cancel", sessionId: start.sessionId },
        })
      );
      expect(cancel.sessions?.[0]?.status).toBe("cancelled");

      const polled = parsePayload(
        await client.callTool({
          name: "claude_code_check",
          arguments: { action: "poll", sessionId: start.sessionId, responseMode: "full" },
        })
      );
      expect(polled.status).toBe("cancelled");

      // Regression expectation: after cancel->poll, transport and other tools remain usable.
      const resources = await client.listResources();
      expect(resources.resources.length).toBeGreaterThan(0);

      const listed = parsePayload(
        await client.callTool({ name: "claude_code_session", arguments: { action: "list" } })
      );
      expect(Array.isArray(listed.sessions)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
