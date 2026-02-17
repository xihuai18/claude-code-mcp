import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServerContext } from "../src/server.js";

async function withClientServer<T>(
  fn: (client: Client, ctx: ReturnType<typeof createServerContext>) => Promise<T>
): Promise<T> {
  const ctx = createServerContext("/tmp");
  const { server, sessionManager } = ctx;
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await fn(client, ctx);
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
          "claude-code-mcp:///compat-report",
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
        version?: unknown;
        resources?: unknown;
      };
      expect(info.name).toBe("claude-code-mcp");
      expect(typeof info.version).toBe("string");
      expect(Array.isArray(info.resources)).toBe(true);
      expect((info.resources as string[]).slice().sort()).toEqual(
        [
          "claude-code-mcp:///compat-report",
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

      const compatRes = await client.readResource({ uri: "claude-code-mcp:///compat-report" });
      expect(compatRes.contents[0]?.mimeType).toBe("application/json");
      const compatContent = compatRes.contents[0];
      const compatText =
        compatContent && "text" in compatContent && typeof compatContent.text === "string"
          ? compatContent.text
          : "{}";
      const compat = JSON.parse(compatText) as {
        packageVersion?: unknown;
        samePlatformRequired?: unknown;
        transport?: unknown;
        limits?: {
          maxSessions?: unknown;
          maxPendingPermissionsPerSession?: unknown;
          eventBuffer?: { maxSize?: unknown; hardMaxSize?: unknown };
        };
        diskResume?: { enabled?: unknown; resumeSecretConfigured?: unknown };
      };
      expect(compat.samePlatformRequired).toBe(true);
      expect(compat.transport).toBe("stdio");
      expect(typeof compat.packageVersion).toBe("string");
      expect(typeof compat.limits?.eventBuffer?.maxSize).toBe("number");
      expect(typeof compat.limits?.eventBuffer?.hardMaxSize).toBe("number");
      expect(typeof compat.diskResume?.enabled).toBe("boolean");
      expect(typeof compat.diskResume?.resumeSecretConfigured).toBe("boolean");
    });
  });

  it("should serialize unlimited limits as 'unlimited' in compat-report", async () => {
    const prevMaxSessions = process.env.CLAUDE_CODE_MCP_MAX_SESSIONS;
    const prevMaxPending = process.env.CLAUDE_CODE_MCP_MAX_PENDING_PERMISSIONS;
    process.env.CLAUDE_CODE_MCP_MAX_SESSIONS = "0";
    process.env.CLAUDE_CODE_MCP_MAX_PENDING_PERMISSIONS = "0";
    try {
      await withClientServer(async (client) => {
        const compatRes = await client.readResource({ uri: "claude-code-mcp:///compat-report" });
        const compatContent = compatRes.contents[0];
        const compatText =
          compatContent && "text" in compatContent && typeof compatContent.text === "string"
            ? compatContent.text
            : "{}";
        const compat = JSON.parse(compatText) as {
          limits?: { maxSessions?: unknown; maxPendingPermissionsPerSession?: unknown };
        };
        expect(compat.limits?.maxSessions).toBe("unlimited");
        expect(compat.limits?.maxPendingPermissionsPerSession).toBe("unlimited");
      });
    } finally {
      if (prevMaxSessions === undefined) delete process.env.CLAUDE_CODE_MCP_MAX_SESSIONS;
      else process.env.CLAUDE_CODE_MCP_MAX_SESSIONS = prevMaxSessions;
      if (prevMaxPending === undefined) delete process.env.CLAUDE_CODE_MCP_MAX_PENDING_PERMISSIONS;
      else process.env.CLAUDE_CODE_MCP_MAX_PENDING_PERMISSIONS = prevMaxPending;
    }
  });

  it("should return updated internal-tools content after runtime discovery", async () => {
    await withClientServer(async (client, ctx) => {
      const first = await client.readResource({ uri: "claude-code-mcp:///internal-tools" });
      const firstContent = first.contents[0];
      const firstText =
        firstContent && "text" in firstContent && typeof firstContent.text === "string"
          ? firstContent.text
          : "{}";
      const firstParsed = JSON.parse(firstText) as {
        tools?: Array<{ name?: string }>;
      };
      expect(Array.isArray(firstParsed.tools)).toBe(true);

      ctx.toolCache.updateFromInit(["Read", "Write", "NewRuntimeTool"]);

      const second = await client.readResource({ uri: "claude-code-mcp:///internal-tools" });
      const secondContent = second.contents[0];
      const secondText =
        secondContent && "text" in secondContent && typeof secondContent.text === "string"
          ? secondContent.text
          : "{}";
      const secondParsed = JSON.parse(secondText) as {
        tools?: Array<{ name?: string }>;
      };
      const names = (secondParsed.tools ?? []).map((t) => t.name);
      expect(names).toContain("NewRuntimeTool");
    });
  });

  it("should notify resource updates when runtime tool catalog changes", async () => {
    await withClientServer(async (_client, ctx) => {
      const listChangedSpy = vi.spyOn(ctx.server, "sendResourceListChanged");

      try {
        ctx.toolCache.updateFromInit(["Read", "Write", "NotifiedRuntimeTool"]);
        await Promise.resolve();
        expect(listChangedSpy).toHaveBeenCalled();
      } finally {
        listChangedSpy.mockRestore();
      }
    });
  });
});
