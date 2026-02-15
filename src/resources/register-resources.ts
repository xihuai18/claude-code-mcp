import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { SessionManager } from "../session/manager.js";
import type { ToolDiscoveryCache } from "../tools/tool-discovery.js";

const RESOURCE_SCHEME = "claude-code-mcp";

function asTextResource(uri: URL, text: string, mimeType: string): ReadResourceResult {
  return {
    contents: [
      {
        uri: uri.toString(),
        text,
        mimeType,
      },
    ],
  };
}

export function resourcesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_MCP_ENABLE_RESOURCES === "1";
}

export function registerResourcesIfEnabled(
  server: McpServer,
  deps: { sessionManager: SessionManager; toolCache: ToolDiscoveryCache }
): void {
  if (!resourcesEnabled()) return;
  registerResources(server, deps);
}

export function registerResources(
  server: McpServer,
  deps: { sessionManager: SessionManager; toolCache: ToolDiscoveryCache }
): void {
  const toolsUri = new URL(`${RESOURCE_SCHEME}:///internal-tools`);
  server.registerResource(
    "internal_tools",
    toolsUri.toString(),
    {
      title: "Internal Tools",
      description: "Claude Code internal tool catalog (static + runtime-discovered).",
      mimeType: "application/json",
    },
    () =>
      asTextResource(
        toolsUri,
        JSON.stringify({ tools: deps.toolCache.getTools() }, null, 2),
        "application/json"
      )
  );

  const gotchasUri = new URL(`${RESOURCE_SCHEME}:///gotchas`);
  server.registerResource(
    "gotchas",
    gotchasUri.toString(),
    {
      title: "Gotchas",
      description: "Practical limits and gotchas when using Claude Code via this MCP server.",
      mimeType: "text/markdown",
    },
    () =>
      asTextResource(
        gotchasUri,
        [
          "# claude-code-mcp: gotchas",
          "",
          "- Permission approvals have a timeout (default 60s) and auto-deny (`actions[].expiresAt`/`remainingMs`).",
          "- `Read` has a per-call size cap in practice (often ~256KB); for large files use `offset`/`limit` or chunk with `Grep`.",
          "- `Edit` with `replace_all=true` is substring replacement; if no match is found the tool returns an error.",
          "- `NotebookEdit` expects native Windows paths; this server normalizes MSYS paths like `/d/...` when possible.",
          "- `TeamDelete` may require members to reach `shutdown_approved`; cleanup can be asynchronous during shutdown.",
          '- Skills may become available later in the same session (early calls may show "Unknown").',
          "- Some internal features (e.g. ToolSearch) may not appear in `availableTools` because it is derived from SDK `system/init.tools`.",
          "",
        ].join("\n"),
        "text/markdown"
      )
  );

  const sessionsUri = new URL(`${RESOURCE_SCHEME}:///sessions`);
  server.registerResource(
    "sessions",
    sessionsUri.toString(),
    {
      title: "Sessions",
      description: "Active sessions (public/redacted shape; no cwd/prompt/env).",
      mimeType: "application/json",
    },
    () =>
      asTextResource(
        sessionsUri,
        JSON.stringify(
          { sessions: deps.sessionManager.list().map((s) => deps.sessionManager.toPublicJSON(s)) },
          null,
          2
        ),
        "application/json"
      )
  );

  const sessionTemplate = new ResourceTemplate(`${RESOURCE_SCHEME}:///sessions/{sessionId}`, {
    list: async () => ({
      resources: deps.sessionManager.list().map((s) => ({
        uri: `${RESOURCE_SCHEME}:///sessions/${encodeURIComponent(s.sessionId)}`,
        name: `session:${s.sessionId}`,
        description: "Public/redacted session info.",
        mimeType: "application/json",
      })),
    }),
    complete: {
      sessionId: async (value) => {
        const prefix = value ?? "";
        return deps.sessionManager
          .list()
          .map((s) => s.sessionId)
          .filter((id) => id.startsWith(prefix))
          .slice(0, 50);
      },
    },
  });

  server.registerResource(
    "session",
    sessionTemplate,
    {
      title: "Session",
      description: "Read a session by ID (public/redacted shape; no cwd/prompt/env).",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const sessionId = String((variables as Record<string, unknown>)["sessionId"] ?? "");
      const info = deps.sessionManager.get(sessionId);
      const payload = info
        ? deps.sessionManager.toPublicJSON(info)
        : { error: "Session not found" };
      return asTextResource(uri, JSON.stringify(payload, null, 2), "application/json");
    }
  );
}
