import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

type ToolResponse = {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

function parseFirstText(res: ToolResponse): unknown {
  const text = res.content?.[0]?.text;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function callToolWithMock(params: {
  modulePath: string;
  exportName: string;
  toolName: string;
  args: Record<string, unknown>;
  errorMessage: string;
}): Promise<ToolResponse> {
  vi.resetModules();
  vi.doMock(params.modulePath, () => ({
    [params.exportName]: vi.fn(() => {
      throw new Error(params.errorMessage);
    }),
  }));

  const { createServer } = await import("../src/server.js");
  const server = createServer("/tmp");
  const client = new Client({ name: "error-shape-test", version: "0.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.callTool({
      name: params.toolName,
      arguments: params.args,
    })) as ToolResponse;
  } finally {
    await client.close();
    await server.close();
    vi.doUnmock(params.modulePath);
  }
}

describe("server tool error payload shapes", () => {
  it("claude_code catch-path returns start-result-shaped structuredContent", async () => {
    const res = await callToolWithMock({
      modulePath: "../src/tools/claude-code.js",
      exportName: "executeClaudeCode",
      toolName: "claude_code",
      args: { prompt: "x" },
      errorMessage: "boom-start",
    });

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      sessionId: "",
      status: "error",
    });

    const textPayload = parseFirstText(res);
    expect(textPayload).toMatchObject({
      sessionId: "",
      status: "error",
    });
  });

  it("claude_code_reply catch-path returns start-result-shaped structuredContent", async () => {
    const res = await callToolWithMock({
      modulePath: "../src/tools/claude-code-reply.js",
      exportName: "executeClaudeCodeReply",
      toolName: "claude_code_reply",
      args: { sessionId: "s1", prompt: "x" },
      errorMessage: "boom-reply",
    });

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      sessionId: "",
      status: "error",
    });

    const textPayload = parseFirstText(res);
    expect(textPayload).toMatchObject({
      sessionId: "",
      status: "error",
    });
  });

  it("claude_code_session catch-path returns session-result-shaped structuredContent", async () => {
    const res = await callToolWithMock({
      modulePath: "../src/tools/claude-code-session.js",
      exportName: "executeClaudeCodeSession",
      toolName: "claude_code_session",
      args: { action: "list" },
      errorMessage: "boom-session",
    });

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      sessions: [],
      isError: true,
    });

    const textPayload = parseFirstText(res);
    expect(textPayload).toMatchObject({
      sessions: [],
      isError: true,
    });
  });

  it("claude_code_check catch-path returns check-result-shaped structuredContent", async () => {
    const res = await callToolWithMock({
      modulePath: "../src/tools/claude-code-check.js",
      exportName: "executeClaudeCodeCheck",
      toolName: "claude_code_check",
      args: { action: "poll", sessionId: "s1" },
      errorMessage: "boom-check",
    });

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      sessionId: "s1",
      status: "error",
      events: [],
      isError: true,
    });

    const textPayload = parseFirstText(res);
    expect(textPayload).toMatchObject({
      sessionId: "s1",
      status: "error",
      events: [],
      isError: true,
    });
  });
});
