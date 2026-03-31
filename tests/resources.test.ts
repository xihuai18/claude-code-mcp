import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServerContext } from "../src/server.js";
import { ErrorCode } from "../src/types.js";
import {
  DEFAULT_CLAUDE_COMMAND_ENV,
  DEFAULT_CLAUDE_PATH_ENV,
} from "../src/utils/claude-executable.js";

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

function createExecutableFixture(commandName: string): { dir: string; filePath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-resource-exec-"));
  const fileName = process.platform === "win32" ? `${commandName}.cmd` : commandName;
  const filePath = path.join(dir, fileName);
  writeFileSync(filePath, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", "utf8");
  if (process.platform !== "win32") chmodSync(filePath, 0o755);
  return { dir, filePath };
}

describe("Resources", () => {
  it("should expose a small set of read-only resources", async () => {
    await withClientServer(async (client, ctx) => {
      const uris = await safeListResources(client);
      expect(uris.sort()).toEqual(
        [
          "claude-code-mcp:///compat-report",
          "claude-code-mcp:///errors",
          "claude-code-mcp:///gotchas",
          "claude-code-mcp:///internal-tools",
          "claude-code-mcp:///quickstart",
          "claude-code-mcp:///server-info",
        ].sort()
      );

      const templates = await safeListTemplates(client);
      expect(templates.slice().sort()).toEqual(
        [
          "claude-code-mcp:///session/{sessionId}",
          "claude-code-mcp:///tools/runtime{?sessionId}",
          "claude-code-mcp:///compat/diff{?client}",
        ].sort()
      );

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
        schemaVersion?: unknown;
        etag?: unknown;
        updatedAt?: unknown;
        capabilities?: { resources?: unknown; toolsListChanged?: unknown };
        resourceTemplates?: unknown;
      };
      expect(info.name).toBe("claude-code-mcp");
      expect(typeof info.version).toBe("string");
      expect(info.schemaVersion).toBe("1.4");
      expect(typeof info.etag).toBe("string");
      expect(typeof info.updatedAt).toBe("string");
      expect(info.capabilities?.resources).toBe(true);
      expect(info.capabilities?.toolsListChanged).toBe(true);
      expect(Array.isArray(info.resourceTemplates)).toBe(true);
      expect(Array.isArray(info.resources)).toBe(true);
      expect((info.resources as string[]).slice().sort()).toEqual(
        [
          "claude-code-mcp:///compat-report",
          "claude-code-mcp:///errors",
          "claude-code-mcp:///server-info",
          "claude-code-mcp:///internal-tools",
          "claude-code-mcp:///gotchas",
          "claude-code-mcp:///quickstart",
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
      const firstTool = Array.isArray(parsed.tools)
        ? (parsed.tools[0] as
            | { permissionModel?: unknown; schemaAvailability?: unknown }
            | undefined)
        : undefined;
      expect(firstTool?.permissionModel).toBe("policy_controlled");
      expect(firstTool?.schemaAvailability).toBe("none");

      const gotchasRes = await client.readResource({ uri: "claude-code-mcp:///gotchas" });
      expect(gotchasRes.contents[0]?.mimeType).toBe("text/markdown");
      const gotchasContent = gotchasRes.contents[0];
      const gotchasText =
        gotchasContent && "text" in gotchasContent && typeof gotchasContent.text === "string"
          ? gotchasContent.text
          : "";
      expect(gotchasText).toContain("gotchas");
      expect(gotchasText).toContain("Severity:");
      expect(gotchasText).toContain("Detection:");
      expect(gotchasText).toContain("Remedy:");

      const quickstartRes = await client.readResource({ uri: "claude-code-mcp:///quickstart" });
      expect(quickstartRes.contents[0]?.mimeType).toBe("text/markdown");
      const quickstartContent = quickstartRes.contents[0];
      const quickstartText =
        quickstartContent &&
        "text" in quickstartContent &&
        typeof quickstartContent.text === "string"
          ? quickstartContent.text
          : "";
      expect(quickstartText).toContain("quickstart");
      expect(quickstartText).toContain("## Required state");
      expect(quickstartText).toContain("Persist these client-side");
      expect(quickstartText).toContain("claude_code_check(action='poll')");
      expect(quickstartText).toContain("respond_permission");
      expect(quickstartText).toContain("allow_for_session");
      expect(quickstartText).toContain("10+ minutes");
      expect(quickstartText).toContain("Adjust poll intervals to the current progress");
      expect(quickstartText).toContain("existing `sessionId`");
      expect(quickstartText).toContain("final result arrives later via polling");
      expect(quickstartText).toContain("`respond_user_input` is not supported");

      const errorsRes = await client.readResource({ uri: "claude-code-mcp:///errors" });
      expect(errorsRes.contents[0]?.mimeType).toBe("application/json");
      const errorsContent = errorsRes.contents[0];
      const errorsText =
        errorsContent && "text" in errorsContent && typeof errorsContent.text === "string"
          ? errorsContent.text
          : "{}";
      const errorsJson = JSON.parse(errorsText) as { codes?: unknown[]; hints?: unknown };
      expect(Array.isArray(errorsJson.codes)).toBe(true);
      expect(errorsJson.codes).toEqual(
        expect.arrayContaining([
          ErrorCode.INVALID_ARGUMENT,
          ErrorCode.SESSION_NOT_FOUND,
          ErrorCode.INTERNAL,
        ])
      );
      expect(errorsJson.hints).toBeDefined();
      expect(errorsJson.hints).not.toBeNull();
      expect(Array.isArray(errorsJson.hints)).toBe(false);
      const hints = errorsJson.hints as Record<string, unknown>;
      expect(typeof hints[ErrorCode.INVALID_ARGUMENT]).toBe("string");
      expect(typeof hints[ErrorCode.SESSION_NOT_FOUND]).toBe("string");
      expect(typeof hints[ErrorCode.INTERNAL]).toBe("string");

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
        schemaVersion?: unknown;
        guidance?: unknown[];
        defaultClaudeExecutable?: {
          source?: unknown;
          command?: unknown;
          resolvedFileName?: unknown;
          usingBundled?: unknown;
        };
        limits?: {
          maxSessions?: unknown;
          maxPendingPermissionsPerSession?: unknown;
          eventBuffer?: { maxSize?: unknown; hardMaxSize?: unknown };
        };
        diskResume?: { enabled?: unknown; resumeSecretConfigured?: unknown };
        toolCounts?: { catalogCount?: unknown; runtimeDiscoveredUniqueCount?: unknown };
        recommendedSettings?: {
          responseMode?: unknown;
          poll?: { cursorStrategy?: unknown };
        };
        features?: {
          resourceTemplates?: unknown;
          sessionInterrupt?: unknown;
          allowForSessionDecision?: unknown;
          respondUserInput?: unknown;
        };
        resourceTemplates?: unknown;
      };
      expect(compat.samePlatformRequired).toBe(true);
      expect(compat.transport).toBe("stdio");
      expect(compat.schemaVersion).toBe("1.4");
      expect(typeof compat.packageVersion).toBe("string");
      expect(typeof compat.limits?.eventBuffer?.maxSize).toBe("number");
      expect(typeof compat.limits?.eventBuffer?.hardMaxSize).toBe("number");
      expect(typeof compat.defaultClaudeExecutable?.source).toBe("string");
      expect(typeof compat.defaultClaudeExecutable?.usingBundled).toBe("boolean");
      expect(typeof compat.diskResume?.enabled).toBe("boolean");
      expect(typeof compat.diskResume?.resumeSecretConfigured).toBe("boolean");
      expect(typeof compat.toolCounts?.catalogCount).toBe("number");
      expect(typeof compat.toolCounts?.runtimeDiscoveredUniqueCount).toBe("number");
      expect(compat.recommendedSettings?.responseMode).toBe("delta_compact");
      expect(typeof compat.recommendedSettings?.poll?.cursorStrategy).toBe("string");
      expect(compat.features?.resourceTemplates).toBe(true);
      expect(compat.features?.sessionInterrupt).toBe(true);
      expect(compat.features?.allowForSessionDecision).toBe(true);
      expect(compat.features?.respondUserInput).toBe(false);
      expect(Array.isArray(compat.guidance)).toBe(true);
      expect(Array.isArray(compat.resourceTemplates)).toBe(true);

      ctx.sessionManager.create({ sessionId: "s-template", cwd: "/tmp" });
      const sessionSnapshot = await client.readResource({
        uri: "claude-code-mcp:///session/s-template",
      });
      const sessionSnapshotContent = sessionSnapshot.contents[0];
      const sessionSnapshotText =
        sessionSnapshotContent &&
        "text" in sessionSnapshotContent &&
        typeof sessionSnapshotContent.text === "string"
          ? sessionSnapshotContent.text
          : "{}";
      const sessionSnapshotJson = JSON.parse(sessionSnapshotText) as {
        found?: unknown;
        session?: { sessionId?: unknown; pendingPermissionCount?: unknown };
      };
      expect(sessionSnapshotJson.found).toBe(true);
      expect(sessionSnapshotJson.session?.sessionId).toBe("s-template");
      expect(sessionSnapshotJson.session?.pendingPermissionCount).toBe(0);

      const runtimeToolsNoInit = await client.readResource({
        uri: "claude-code-mcp:///tools/runtime?sessionId=s-template",
      });
      const runtimeToolsNoInitContent = runtimeToolsNoInit.contents[0];
      const runtimeToolsNoInitText =
        runtimeToolsNoInitContent &&
        "text" in runtimeToolsNoInitContent &&
        typeof runtimeToolsNoInitContent.text === "string"
          ? runtimeToolsNoInitContent.text
          : "{}";
      const runtimeToolsNoInitJson = JSON.parse(runtimeToolsNoInitText) as {
        source?: unknown;
        availableTools?: unknown[];
      };
      expect(runtimeToolsNoInitJson.source).toBe("session_without_init");
      expect(Array.isArray(runtimeToolsNoInitJson.availableTools)).toBe(true);
      expect(runtimeToolsNoInitJson.availableTools).toHaveLength(0);

      ctx.sessionManager.setInitTools("s-template", ["Read", "Write", "ExternalX"]);
      const runtimeToolsWithInit = await client.readResource({
        uri: "claude-code-mcp:///tools/runtime?sessionId=s-template",
      });
      const runtimeToolsWithInitContent = runtimeToolsWithInit.contents[0];
      const runtimeToolsWithInitText =
        runtimeToolsWithInitContent &&
        "text" in runtimeToolsWithInitContent &&
        typeof runtimeToolsWithInitContent.text === "string"
          ? runtimeToolsWithInitContent.text
          : "{}";
      const runtimeToolsWithInitJson = JSON.parse(runtimeToolsWithInitText) as {
        source?: unknown;
        availableTools?: Array<{ name?: unknown }>;
      };
      expect(runtimeToolsWithInitJson.source).toBe("session_runtime");
      expect(runtimeToolsWithInitJson.availableTools?.map((t) => t.name)).toContain("ExternalX");

      const compatDiff = await client.readResource({
        uri: "claude-code-mcp:///compat/diff?client=codex",
      });
      const compatDiffContent = compatDiff.contents[0];
      const compatDiffText =
        compatDiffContent &&
        "text" in compatDiffContent &&
        typeof compatDiffContent.text === "string"
          ? compatDiffContent.text
          : "{}";
      const compatDiffJson = JSON.parse(compatDiffText) as {
        clientFamily?: unknown;
        recommendedSettings?: { responseMode?: unknown };
      };
      expect(compatDiffJson.clientFamily).toBe("codex");
      expect(compatDiffJson.recommendedSettings?.responseMode).toBe("delta_compact");
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

  it("should report the resolved default Claude executable in compat-report", async () => {
    const fixture = createExecutableFixture("claude-internal");
    vi.stubEnv("PATH", fixture.dir);
    vi.stubEnv(DEFAULT_CLAUDE_COMMAND_ENV, "claude-internal");
    vi.stubEnv(DEFAULT_CLAUDE_PATH_ENV, "");
    try {
      await withClientServer(async (client) => {
        const compatRes = await client.readResource({ uri: "claude-code-mcp:///compat-report" });
        const compatContent = compatRes.contents[0];
        const compatText =
          compatContent && "text" in compatContent && typeof compatContent.text === "string"
            ? compatContent.text
            : "{}";
        const compat = JSON.parse(compatText) as {
          defaultClaudeExecutable?: {
            source?: unknown;
            command?: unknown;
            resolvedFileName?: unknown;
            usingBundled?: unknown;
          };
        };

        expect(compat.defaultClaudeExecutable?.source).toBe("env_command");
        expect(compat.defaultClaudeExecutable?.command).toBe("claude-internal");
        expect(compat.defaultClaudeExecutable?.resolvedFileName).toBe(
          path.basename(fixture.filePath)
        );
        expect(compat.defaultClaudeExecutable?.usingBundled).toBe(false);
      });
    } finally {
      vi.unstubAllEnvs();
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
