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

  it("should keep claude_code advanced schema at 20 low-frequency fields + 2 aliases", async () => {
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
      const advancedProps = claudeCode?.inputSchema?.properties?.advanced?.properties ?? {};
      const keys = Object.keys(advancedProps);
      expect(keys).toHaveLength(22);
      expect(keys).toContain("effort");
      expect(keys).toContain("thinking");
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
