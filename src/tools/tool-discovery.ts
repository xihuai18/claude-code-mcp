import type { ToolInfo } from "../types.js";

type ToolCatalogEntry = Omit<ToolInfo, "name">;
type ToolDiscoveryUpdatedCallback = (tools: ToolInfo[]) => void;

const DEFAULT_PERMISSION_MODEL: ToolInfo["permissionModel"] = "policy_controlled";
const DEFAULT_SCHEMA_AVAILABILITY: ToolInfo["schemaAvailability"] = "none";

export const TOOL_CATALOG: Record<string, ToolCatalogEntry> = {
  Bash: {
    description: "Run shell commands",
    category: "execute",
    notes: ["Execution may require permission approval depending on session policy."],
  },
  Read: {
    description: "Read file contents (large files: use offset/limit or Grep)",
    category: "file_read",
    notes: ["Large reads are often capped by the backend; use offset/limit when needed."],
  },
  Write: {
    description: "Create or overwrite files",
    category: "file_write",
  },
  Edit: {
    description: "Targeted edits (replace_all is substring-based)",
    category: "file_write",
  },
  Glob: {
    description: "Find files by glob pattern",
    category: "file_read",
  },
  Grep: {
    description: "Search file contents (regex)",
    category: "file_read",
  },
  NotebookEdit: {
    description: "Edit Jupyter notebook cells (Windows paths normalized)",
    category: "file_write",
  },
  WebFetch: {
    description: "Fetch web page or API content",
    category: "network",
  },
  WebSearch: { description: "Web search", category: "network" },
  Task: {
    description: "Spawn subagent (must be in allowedTools)",
    category: "agent",
    availabilityConditions: ["Requires Task to be visible and approved by session policy."],
  },
  TaskOutput: { description: "Get subagent output", category: "agent" },
  TaskStop: { description: "Cancel subagent", category: "agent" },
  TodoWrite: {
    description: "Task/todo checklist",
    category: "agent",
  },
  AskUserQuestion: {
    description: "Ask user a question",
    category: "interaction",
  },
  SubscribeMcpResource: {
    description: "Subscribe to an MCP resource stream",
    category: "mcp",
    notes: ["Requires an MCP server that supports resource subscriptions."],
  },
  UnsubscribeMcpResource: {
    description: "Unsubscribe from an MCP resource stream",
    category: "mcp",
  },
  SubscribePolling: {
    description: "Subscribe to periodic polling",
    category: "mcp",
  },
  UnsubscribePolling: {
    description: "Unsubscribe from periodic polling",
    category: "mcp",
  },
  TeamDelete: {
    description: "Delete team (may need shutdown_approved first)",
    category: "agent",
    notes: ["Team cleanup can be asynchronous during shutdown."],
  },
};

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function withToolDefaults(tool: ToolInfo): ToolInfo {
  return {
    ...tool,
    permissionModel: tool.permissionModel ?? DEFAULT_PERMISSION_MODEL,
    schemaAvailability: tool.schemaAvailability ?? DEFAULT_SCHEMA_AVAILABILITY,
  };
}

export function discoverToolsFromInit(initTools: string[]): ToolInfo[] {
  const names = uniq(initTools.filter((t) => typeof t === "string" && t.trim() !== ""));
  return names.map((name) =>
    withToolDefaults({
      name,
      description: TOOL_CATALOG[name]?.description ?? name,
      category: TOOL_CATALOG[name]?.category,
      availabilityConditions: TOOL_CATALOG[name]?.availabilityConditions,
      platformConstraints: TOOL_CATALOG[name]?.platformConstraints,
      notes: TOOL_CATALOG[name]?.notes,
    })
  );
}

export function defaultCatalogTools(): ToolInfo[] {
  return Object.keys(TOOL_CATALOG)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => withToolDefaults({ name, ...TOOL_CATALOG[name] }));
}

export class ToolDiscoveryCache {
  private cached: ToolInfo[];
  private onUpdated?: ToolDiscoveryUpdatedCallback;

  constructor(initial?: ToolInfo[], onUpdated?: ToolDiscoveryUpdatedCallback) {
    this.cached = initial ?? defaultCatalogTools();
    this.onUpdated = onUpdated;
  }

  getTools(): ToolInfo[] {
    return this.cached;
  }

  updateFromInit(initTools: string[]): { updated: boolean; tools: ToolInfo[] } {
    const discovered = discoverToolsFromInit(initTools);
    const next = mergeToolLists(discovered, defaultCatalogTools());
    const updated = JSON.stringify(next) !== JSON.stringify(this.cached);
    if (updated) {
      this.cached = next;
      try {
        this.onUpdated?.(this.cached);
      } catch {
        // ignore observer errors (stdout is reserved for MCP)
      }
    }
    return { updated, tools: this.cached };
  }
}

export function mergeToolLists(primary: ToolInfo[], fallback: ToolInfo[]): ToolInfo[] {
  const byName = new Map<string, ToolInfo>();
  for (const t of fallback) byName.set(t.name, t);
  for (const t of primary) byName.set(t.name, t);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function groupByCategory(tools: ToolInfo[]): Record<string, ToolInfo[]> {
  const grouped: Record<string, ToolInfo[]> = {};
  for (const tool of tools) {
    const category = tool.category ?? "other";
    grouped[category] ??= [];
    grouped[category].push(tool);
  }
  for (const category of Object.keys(grouped)) {
    grouped[category].sort((a, b) => a.name.localeCompare(b.name));
  }
  return grouped;
}

export function buildInternalToolsDescription(tools: ToolInfo[]): string {
  const grouped = groupByCategory(tools);
  const categories = Object.keys(grouped).sort((a, b) => a.localeCompare(b));

  let desc =
    "Start a Claude Code session and return sessionId.\n" +
    "Use claude_code_check to poll events/results and handle permissions.\n" +
    "Adjust polling cadence to progress: poll faster while new events/actions are arriving, and slower when the session is quietly thinking.\n" +
    "Long-running work is normal: Claude Code can keep working for 10+ minutes, especially with high/max effort, so wait for polling to settle before assuming it is stuck.\n" +
    "If you want to continue after a run pauses or finishes, use claude_code_reply with the same sessionId instead of starting a brand-new claude_code session.\n\n";
  desc += "Internal tools (authoritative list: includeTools=true in claude_code_check):\n";

  for (const category of categories) {
    desc += `\n[${category}]\n`;
    for (const tool of grouped[category]) {
      desc += `- ${tool.name}: ${tool.description}\n`;
    }
  }

  desc +=
    "\nPermission control: allowedTools auto-approves; disallowedTools always denies; others require approval.\n";
  return desc;
}
