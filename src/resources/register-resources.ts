import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDiscoveryCache } from "../tools/tool-discovery.js";

const RESOURCE_SCHEME = "claude-code-mcp";

export const RESOURCE_URIS = {
  serverInfo: `${RESOURCE_SCHEME}:///server-info`,
  internalTools: `${RESOURCE_SCHEME}:///internal-tools`,
  gotchas: `${RESOURCE_SCHEME}:///gotchas`,
} as const;

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

export function registerResources(
  server: McpServer,
  deps: { toolCache: ToolDiscoveryCache }
): void {
  // "Static resources only": keep URIs stable and keep resource payloads stable across reads.
  // This intentionally snapshots any dynamic dependencies at registration time.
  const toolCatalogSnapshot = deps.toolCache.getTools();

  const serverInfoUri = new URL(RESOURCE_URIS.serverInfo);
  const serverInfoText = JSON.stringify(
    {
      name: "claude-code-mcp",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      resources: Object.values(RESOURCE_URIS),
      toolCatalogCount: toolCatalogSnapshot.length,
    },
    null,
    2
  );
  server.registerResource(
    "server_info",
    serverInfoUri.toString(),
    {
      title: "Server Info",
      description: "Static server metadata snapshot (version/platform/runtime).",
      mimeType: "application/json",
    },
    () => asTextResource(serverInfoUri, serverInfoText, "application/json")
  );

  const toolsUri = new URL(RESOURCE_URIS.internalTools);
  const internalToolsText = JSON.stringify({ tools: toolCatalogSnapshot }, null, 2);
  server.registerResource(
    "internal_tools",
    toolsUri.toString(),
    {
      title: "Internal Tools",
      description: "Claude Code internal tool catalog snapshot (static + runtime-discovered).",
      mimeType: "application/json",
    },
    () => asTextResource(toolsUri, internalToolsText, "application/json")
  );

  const gotchasUri = new URL(RESOURCE_URIS.gotchas);
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
          "- Permission approvals have a timeout (default 60s, server-clamped to 5min) and auto-deny (`actions[].expiresAt`/`remainingMs`).",
          "- `Read` has a per-call size cap in practice (often ~256KB); for large files use `offset`/`limit` or chunk with `Grep`.",
          "- `Edit` with `replace_all=true` is substring replacement; if no match is found the tool returns an error.",
          "- On Windows, this server normalizes common MSYS-style paths (e.g. `/d/...`, `/mnt/c/...`, `/cygdrive/c/...`, `//server/share/...`) for `cwd`, `additionalDirectories`, and tool inputs that include `file_path`.",
          "- `TeamDelete` may require members to reach `shutdown_approved`; cleanup can be asynchronous during shutdown.",
          '- Skills may become available later in the same session (early calls may show "Unknown").',
          "- Some internal features (e.g. ToolSearch) may not appear in `availableTools` because it is derived from SDK `system/init.tools`.",
          "",
        ].join("\n"),
        "text/markdown"
      )
  );
}
