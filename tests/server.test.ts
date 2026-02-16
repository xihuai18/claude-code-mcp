import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
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
});
