import type { ToolInfo } from "../types.js";

type ToolCatalogEntry = Omit<ToolInfo, "name">;

export const TOOL_CATALOG: Record<string, ToolCatalogEntry> = {
  Bash: {
    description: "Run shell commands (e.g. npm install, git commit, ls) in the project directory.",
    category: "execute",
  },
  Read: { description: "Read the contents of a file given its path.", category: "file_read" },
  Write: {
    description: "Create a new file or completely replace an existing file's contents.",
    category: "file_write",
  },
  Edit: {
    description:
      "Make targeted changes to specific parts of an existing file without rewriting the whole file.",
    category: "file_write",
  },
  Glob: {
    description: "Find files by name pattern (e.g. '**/*.ts' finds all TypeScript files).",
    category: "file_read",
  },
  Grep: {
    description: "Search inside files for text or regex patterns (like grep/ripgrep).",
    category: "file_read",
  },
  NotebookEdit: {
    description: "Edit individual cells in Jupyter notebooks (.ipynb files).",
    category: "file_write",
  },
  WebFetch: {
    description: "Download and read the content of a web page or API endpoint.",
    category: "network",
  },
  WebSearch: { description: "Search the web and return relevant results.", category: "network" },
  Task: {
    description:
      "Spawn a subagent to handle a subtask independently (requires this tool to be in allowedTools).",
    category: "agent",
  },
  TaskOutput: { description: "Get the output from a background subagent task.", category: "agent" },
  TaskStop: { description: "Cancel a running background subagent task.", category: "agent" },
  TodoWrite: {
    description: "Create and update a structured task/todo checklist.",
    category: "agent",
  },
  AskUserQuestion: {
    description: "Ask the user a question and wait for their answer before continuing.",
    category: "interaction",
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

  constructor(initial?: ToolInfo[]) {
    this.cached = initial ?? defaultCatalogTools();
  }

  getTools(): ToolInfo[] {
    return this.cached;
  }

  updateFromInit(initTools: string[]): { updated: boolean; tools: ToolInfo[] } {
    const discovered = discoverToolsFromInit(initTools);
    const next = mergeToolLists(discovered, defaultCatalogTools());
    const updated = JSON.stringify(next) !== JSON.stringify(this.cached);
    if (updated) this.cached = next;
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
    "Launches an autonomous coding agent that can read/write files, run shell commands, search code, " +
    "manage git, access the web, and more. " +
    "Returns immediately with a sessionId — the agent runs asynchronously in the background.\n\n" +
    "Workflow:\n" +
    '1. Call claude_code with a prompt → returns { sessionId, status: "running", pollInterval }\n' +
    '2. Poll with claude_code_check (action="poll") to receive progress events and the final result\n' +
    '3. If the agent needs permission for a tool call, approve or deny via claude_code_check (action="respond_permission")\n\n';

  desc +=
    "Defaults:\n" +
    "- settingSources: ['user', 'project', 'local'] (loads ~/.claude/settings.json, .claude/settings.json, .claude/settings.local.json, and CLAUDE.md)\n" +
    "- persistSession: true\n" +
    "- sessionInitTimeoutMs: 10000\n" +
    "- permissionRequestTimeoutMs: 60000\n" +
    "- allowedTools/disallowedTools: [] (none)\n" +
    "- resumeToken: omitted unless CLAUDE_CODE_MCP_RESUME_SECRET is set on the server\n\n";
  desc +=
    "Internal tools available to the agent (use allowedTools/disallowedTools to control approval policy; " +
    "authoritative list returned by claude_code_check with includeTools=true):\n";

  for (const category of categories) {
    desc += `\n[${category}]\n`;
    for (const tool of grouped[category]) {
      desc += `- ${tool.name}: ${tool.description}\n`;
    }
  }

  desc +=
    "\nUse `allowedTools` to pre-approve tools (no permission prompts). " +
    "Use `disallowedTools` to permanently block specific tools. " +
    'Any tool not in either list will pause the session (status: "waiting_permission") until approved or denied via claude_code_check.\n';
  return desc;
}
