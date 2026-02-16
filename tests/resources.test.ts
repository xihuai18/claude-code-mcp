import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServerContext } from "../src/server.js";

async function withClientServer<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const { server, sessionManager } = createServerContext("/tmp");
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await fn(client);
  } finally {
    await client.close();
    sessionManager.destroy();
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
      const infoContent = infoRes.contents[0];
      const infoText =
        infoContent && "text" in infoContent && typeof infoContent.text === "string"
          ? infoContent.text
          : "{}";
      const info = JSON.parse(infoText) as {
        name?: unknown;
        resources?: unknown;
      };
      expect(info.name).toBe("claude-code-mcp");
      expect(Array.isArray(info.resources)).toBe(true);
      expect((info.resources as string[]).slice().sort()).toEqual(
        [
          "claude-code-mcp:///server-info",
          "claude-code-mcp:///internal-tools",
          "claude-code-mcp:///gotchas",
        ]
          .slice()
          .sort()
      );

      const toolsRes = await client.readResource({ uri: "claude-code-mcp:///internal-tools" });
      expect(toolsRes.contents[0]?.mimeType).toBe("application/json");
      const toolsContent = toolsRes.contents[0];
      const toolsText =
        toolsContent && "text" in toolsContent && typeof toolsContent.text === "string"
          ? toolsContent.text
          : "{}";
      const parsed = JSON.parse(toolsText) as { tools?: unknown };
      expect(Array.isArray(parsed.tools)).toBe(true);

      const gotchasRes = await client.readResource({ uri: "claude-code-mcp:///gotchas" });
      expect(gotchasRes.contents[0]?.mimeType).toBe("text/markdown");
      const gotchasContent = gotchasRes.contents[0];
      const gotchasText =
        gotchasContent && "text" in gotchasContent && typeof gotchasContent.text === "string"
          ? gotchasContent.text
          : "";
      expect(gotchasText).toContain("gotchas");
    });
  });
});
