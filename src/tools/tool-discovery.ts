import type { ToolInfo } from "../types.js";

type ToolCatalogEntry = Omit<ToolInfo, "name">;
type ToolDiscoveryUpdatedCallback = (tools: ToolInfo[]) => void;

export const TOOL_CATALOG: Record<string, ToolCatalogEntry> = {
  Bash: {
    description: "Run shell commands",
    category: "execute",
  },
  Read: {
    description: "Read file contents (large files: use offset/limit or Grep)",
    category: "file_read",
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
  TeamDelete: {
    description: "Delete team (may need shutdown_approved first)",
    category: "agent",
  },
};

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function discoverToolsFromInit(initTools: string[]): ToolInfo[] {
  const names = uniq(initTools.filter((t) => typeof t === "string" && t.trim() !== ""));
  return names.map((name) => ({
    name,
    description: TOOL_CATALOG[name]?.description ?? name,
    category: TOOL_CATALOG[name]?.category,
  }));
}

export function defaultCatalogTools(): ToolInfo[] {
  return Object.keys(TOOL_CATALOG)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, ...TOOL_CATALOG[name] }));
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
    "Start a new Claude Code agent session.\n\n" +
    "Launches an autonomous coding agent that can read/write files, run commands, search code, and more. " +
    "Returns immediately with a sessionId — poll with claude_code_check for events and results.\n\n" +
    "Workflow:\n" +
    '1. claude_code → { sessionId, status: "running", pollInterval }\n' +
    '2. claude_code_check (action="poll") → progress events + final result\n' +
    '3. claude_code_check (action="respond_permission") → approve/deny tool calls\n\n';

  desc +=
    "Key defaults: settingSources=['user','project','local'] (loads all settings + CLAUDE.md). " +
    "Permission prompts auto-deny on timeout; check actions[].expiresAt/remainingMs.\n\n";
  desc +=
    "Internal tools (use allowedTools/disallowedTools to control; " +
    "authoritative list via claude_code_check includeTools=true):\n";

  for (const category of categories) {
    desc += `\n[${category}]\n`;
    for (const tool of grouped[category]) {
      desc += `- ${tool.name}: ${tool.description}\n`;
    }
  }

  desc +=
    "\nSecurity: Only allow tools you yourself are authorized to perform. " +
    "When in doubt, leave allowedTools/disallowedTools empty and review each request via claude_code_check.\n\n";
  desc +=
    "allowedTools = auto-approve (no prompts). disallowedTools = permanently block. " +
    'Unlisted tools pause the session ("waiting_permission") until approved/denied.\n';
  return desc;
}
