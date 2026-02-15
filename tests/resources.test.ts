import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

async function withClientServer<T>(fn: (client: Client) => Promise<T>): Promise<T> {
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

describe("Resources", () => {
  it("should expose a small set of read-only resources", async () => {
    await withClientServer(async (client) => {
      const uris = await safeListResources(client);
      expect(uris.sort()).toEqual(
        [
          "claude-code-mcp:///gotchas",
          "claude-code-mcp:///internal-tools",
          "claude-code-mcp:///server-info",
        ].sort()
      );

      const templates = await safeListTemplates(client);
      expect(templates).toEqual([]);

      const infoRes = await client.readResource({ uri: "claude-code-mcp:///server-info" });
      expect(infoRes.contents[0]?.mimeType).toBe("application/json");
      const info = JSON.parse(infoRes.contents[0]?.text ?? "{}") as { name?: unknown };
      expect(info.name).toBe("claude-code-mcp");

      const toolsRes = await client.readResource({ uri: "claude-code-mcp:///internal-tools" });
      expect(toolsRes.contents[0]?.mimeType).toBe("application/json");
      const parsed = JSON.parse(toolsRes.contents[0]?.text ?? "{}") as { tools?: unknown };
      expect(Array.isArray(parsed.tools)).toBe(true);

      const gotchasRes = await client.readResource({ uri: "claude-code-mcp:///gotchas" });
      expect(gotchasRes.contents[0]?.mimeType).toBe("text/markdown");
      expect(gotchasRes.contents[0]?.text).toContain("gotchas");
    });
  });
});
