import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

async function withClientServer<T>(
  enableResources: boolean,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const prev = process.env.CLAUDE_CODE_MCP_ENABLE_RESOURCES;
  if (enableResources) process.env.CLAUDE_CODE_MCP_ENABLE_RESOURCES = "1";
  else delete process.env.CLAUDE_CODE_MCP_ENABLE_RESOURCES;

  const server = createServer("/tmp");
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
    if (prev === undefined) delete process.env.CLAUDE_CODE_MCP_ENABLE_RESOURCES;
    else process.env.CLAUDE_CODE_MCP_ENABLE_RESOURCES = prev;
  }
}

async function safeListResources(client: Client): Promise<string[]> {
  try {
    const res = await client.listResources();
    return res.resources.map((r) => r.uri);
  } catch {
    return [];
  }
}

async function safeListTemplates(client: Client): Promise<string[]> {
  try {
    const res = await client.listResourceTemplates();
    return res.resourceTemplates.map((t) => t.uriTemplate);
  } catch {
    return [];
  }
}

describe("Resources (optional)", () => {
  it("should be disabled by default", async () => {
    await withClientServer(false, async (client) => {
      const uris = await safeListResources(client);
      const templates = await safeListTemplates(client);
      expect(uris).toEqual([]);
      expect(templates).toEqual([]);
    });
  });

  it("should expose a small set of read-only resources when enabled", async () => {
    await withClientServer(true, async (client) => {
      const uris = await safeListResources(client);
      expect(uris).toContain("claude-code-mcp:///internal-tools");
      expect(uris).toContain("claude-code-mcp:///gotchas");
      expect(uris).toContain("claude-code-mcp:///sessions");

      const templates = await safeListTemplates(client);
      expect(templates).toContain("claude-code-mcp:///sessions/{sessionId}");

      const toolsRes = await client.readResource({ uri: "claude-code-mcp:///internal-tools" });
      expect(toolsRes.contents[0]?.mimeType).toBe("application/json");
      const parsed = JSON.parse(toolsRes.contents[0]?.text ?? "{}") as { tools?: unknown };
      expect(Array.isArray(parsed.tools)).toBe(true);

      const sessionsRes = await client.readResource({ uri: "claude-code-mcp:///sessions" });
      const sessions = JSON.parse(sessionsRes.contents[0]?.text ?? "{}") as { sessions?: unknown };
      expect(Array.isArray(sessions.sessions)).toBe(true);
    });
  });
});
