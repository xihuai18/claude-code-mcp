# claude-code-mcp

[![npm version](https://img.shields.io/npm/v/@leo000001/claude-code-mcp.svg)](https://www.npmjs.com/package/@leo000001/claude-code-mcp)
[![license](https://img.shields.io/npm/l/@leo000001/claude-code-mcp.svg)](https://github.com/xihuai18/claude-code-mcp/blob/HEAD/LICENSE)
[![node](https://img.shields.io/node/v/@leo000001/claude-code-mcp.svg)](https://nodejs.org)

MCP server that wraps [Claude Code (Claude Agent SDK)](https://docs.anthropic.com/en/docs/claude-code/overview) as tools, enabling any MCP client to invoke Claude Code for autonomous coding tasks. Designed for local use — the MCP server and client are expected to run on the same machine. It works especially well with OpenCode/Codex-style clients that prefer async polling and explicit permission decisions.

Inspired by the [Codex MCP](https://developers.openai.com/codex/guides/agents-sdk/) design philosophy — minimum tools, maximum capability.

This package is **CLI-first**: it is intended to run as an MCP server process (`npx @leo000001/claude-code-mcp`), not as a stable programmatic library API.

## Visibility Boundary

Not every piece of documentation below is visible to an MCP-connected coding agent.

- **Usually visible to the agent:** MCP tool names, tool descriptions, input field descriptions, and MCP resources that the client explicitly reads.
- **Not safe to assume visible:** this `README.md`, `docs/DESIGN.md`, `AGENTS.md`, and other repository files unless the client or orchestrator copies that content into the model context.
- **Authoring rule:** keep protocol-critical calling rules in tool descriptions and MCP resources first; mirror them in README for humans, but do not rely on README alone.

In practice, the most important runtime rules are duplicated in the `claude_code*` tool descriptions and the `quickstart` / `gotchas` / `compat-report` resources so async polling clients can succeed even when they never read this file.

## Features

- **4 tools** covering the full agent lifecycle: start, continue, check/poll, manage
- **Read-only MCP resources** for server info, internal tool catalog, and compatibility diagnostics
- **Session management** with resume and fork support
- **Local settings loaded by default** — automatically reads `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, and `CLAUDE.md` so the agent behaves like your local Claude Code CLI
- **Async permissions** — allow/deny lists + explicit approvals via `claude_code_check`
- **Custom subagents** — define specialized agents per session
- **Cost tracking** — per-session turn and cost accounting
- **Session cancellation** via AbortController
- **Auto-cleanup** — 30-minute idle timeout for expired sessions
- **Security** — callers control tool permissions via allow/deny lists + explicit permission decisions

See `CHANGELOG.md` for release history.

## Prerequisites

- **Node.js >= 18** is required.
- **Same-platform deployment** — this MCP server is designed to run on the same machine as the MCP client. It communicates via stdio (child process), reads local Claude configuration files from `~/.claude/`, and accesses the local file system directly. Remote deployment is not supported.

This MCP server uses the [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) package, which **bundles its own Claude Code CLI** (`cli.js`). When no explicit `pathToClaudeCodeExecutable` is provided, this server now prefers a detected local `claude` command, then `claude-internal`, and falls back to the SDK-bundled CLI if neither is found.

- The SDK bundles a Claude Code CLI; its version generally tracks the SDK package version, but the exact scheme is not guaranteed
- Default executable resolution order is: request-level `pathToClaudeCodeExecutable` -> `CLAUDE_CODE_MCP_DEFAULT_CLAUDE_PATH` -> `CLAUDE_CODE_MCP_DEFAULT_CLAUDE_COMMAND` -> auto-detected `claude` -> auto-detected `claude-internal` -> SDK-bundled CLI
- **Configuration is shared** — the bundled CLI reads API keys and settings from `~/.claude/`, same as the system-installed `claude`
- **All local settings are loaded by default** — unlike the raw SDK (which defaults to isolation mode), this MCP server loads `user`, `project`, and `local` settings automatically, including `CLAUDE.md` project context. Pass `advanced.settingSources: []` to opt out
- You must have Claude Code configured (API key set up) before using this MCP server: see [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code/overview)

> **Note:** The bundled CLI version may differ from your system-installed `claude`. To check: `claude --version` (system) vs `npm ls @anthropic-ai/claude-agent-sdk` (SDK).

## Quick Start

### As an MCP server (recommended)

Install globally or use `npx` (no install needed):

```bash
npm install -g @leo000001/claude-code-mcp
```

Add to your MCP client configuration (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "npx",
      "args": ["-y", "@leo000001/claude-code-mcp"]
    }
  }
}
```

> Some clients cache tool/resource metadata at connect-time. This server emits `notifications/tools/list_changed` and `notifications/resources/list_changed` after runtime tool discovery so clients can refresh both the `claude_code` tool description and `internal-tools` resource.

### Anthropic Claude Code CLI (as an MCP client)

```bash
claude mcp add --transport stdio claude-code -- npx -y @leo000001/claude-code-mcp
```

### OpenCode

Add a local MCP entry in `opencode.json` / `opencode.jsonc` (project) or the global OpenCode config under `~/.config/opencode/`:

```json
{
  "mcp": {
    "claude-code": {
      "type": "local",
      "command": ["npx", "-y", "@leo000001/claude-code-mcp"],
      "enabled": true
    }
  }
}
```

OpenCode tip: start with `claude_code`, keep the returned `sessionId`, then background-poll with `claude_code_check`. When approvals appear, `decision: "allow_for_session"` is usually the best UX because it reduces repeated prompts for the same tool in a session.

> OpenCode project configs can launch local commands. Only enable repository-level MCP configs in repos you trust.

### OpenAI Codex CLI

```bash
codex mcp add claude-code -- npx -y @leo000001/claude-code-mcp
```

Or manually add to `~/.codex/config.toml`:

```toml
[mcp_servers.claude-code-mcp]
command = "npx"
args = ["-y", "@leo000001/claude-code-mcp"]
```

Codex supports both user-level (`~/.codex/config.toml`) and project-level (`.codex/config.toml`) configuration. See [Codex config reference](https://developers.openai.com/codex/config-reference) for advanced options like `tool_timeout_sec` and `enabled_tools`.

### From source

```bash
git clone https://github.com/xihuai18/claude-code-mcp.git
cd claude-code-mcp
npm install
npm run build
npm start
```

## Tools

### `claude_code` — Start a new session

Start a new Claude Code session. The agent autonomously performs coding tasks: reading/writing files, running shell commands, searching code, managing git, and interacting with APIs.

Important protocol note: this call starts background work and returns quickly with `sessionId`; it does not return the final result. Callers must poll `claude_code_check(action="poll")`, persist `nextCursor`, and use `claude_code_reply` to continue the same session later.

| Parameter                    | Type             | Required | Description                                                                                                                                                                                                   |
| ---------------------------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                     | string           | Yes      | Task or question for Claude Code                                                                                                                                                                              |
| `cwd`                        | string           | No       | Working directory (defaults to server cwd)                                                                                                                                                                    |
| `allowedTools`               | string[]         | No       | Auto-approved tool names. Default: `[]` (none). This is not a strict allowlist unless `strictAllowedTools=true`. Example: `["Bash", "Read", "Write", "Edit"]`                                                 |
| `strictAllowedTools`         | boolean          | No       | Server-side strict allowlist toggle. When `true`, tools outside `allowedTools` are denied. Default: `false`                                                                                                   |
| `disallowedTools`            | string[]         | No       | Forbidden tool names. Default: `[]` (none). SDK behavior: disallowed tools are removed from the model's context. Takes precedence over `allowedTools` and will be denied even if later approved interactively |
| `maxTurns`                   | number           | No       | Maximum number of agent reasoning steps. Each step may involve one or more tool calls. Default: SDK/Claude Code default                                                                                       |
| `model`                      | string           | No       | Model to use (e.g. `"claude-sonnet-4-5-20250929"`). Default: SDK/Claude Code default                                                                                                                          |
| `effort`                     | string           | No       | Effort string: `"low"`, `"medium"`, `"high"`, `"max"`. Default: SDK/Claude Code default                                                                                                                       |
| `thinking`                   | object           | No       | Thinking config object, not a string: `{ type: "adaptive" }`, `{ type: "enabled", budgetTokens?: N }`, or `{ type: "disabled" }`. Do not pass `"low"`/`"high"` here. Default: SDK/Claude Code default         |
| `systemPrompt`               | string \| object | No       | Override the agent's system prompt. Default: SDK/Claude Code default. Pass a string for full replacement, or `{ type: "preset", preset: "claude_code", append?: "..." }` to extend the default prompt         |
| `permissionRequestTimeoutMs` | number           | No       | Timeout in milliseconds waiting for permission decisions, auto-deny on expiry. Default: `60000` (server-clamped to 5min)                                                                                      |
| `advanced`                   | object           | No       | Advanced/low-frequency parameters (see below)                                                                                                                                                                 |

<details>
<summary><code>advanced</code> object parameters (24 low-frequency parameters)</summary>

| Parameter                             | Type               | Description                                                                                                                                                                                                                             |
| ------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advanced.tools`                      | string[] \| object | Visible built-in tool set. Array of exact tool names, `[]` to disable built-ins, or `{ type: "preset", preset: "claude_code" }` for the default set. This controls what Claude can see/call; `allowedTools` only controls pre-approval. |
| `advanced.persistSession`             | boolean            | Persist session history to disk (`~/.claude/projects/`). Default: `true`. Set `false` to disable.                                                                                                                                       |
| `advanced.sessionInitTimeoutMs`       | number             | Session init timeout in milliseconds waiting for `system/init`. Default: `10000`.                                                                                                                                                       |
| `advanced.agents`                     | object             | Define custom sub-agents the main agent can delegate tasks to. Default: none. SDK default: if a sub-agent omits `tools`, it inherits all tools from the parent.                                                                         |
| `advanced.agent`                      | string             | Name of a custom agent (defined in `agents`) to use as the primary agent. Default: omitted                                                                                                                                              |
| `advanced.maxBudgetUsd`               | number             | Maximum budget in USD. Default: SDK/Claude Code default                                                                                                                                                                                 |
| `advanced.betas`                      | string[]           | Beta features (e.g. `["context-1m-2025-08-07"]`). Default: none                                                                                                                                                                         |
| `advanced.additionalDirectories`      | string[]           | Additional directories the agent can access beyond cwd. Default: none                                                                                                                                                                   |
| `advanced.outputFormat`               | object             | Structured output config: `{ type: "json_schema", schema: {...} }`. Default: omitted (plain text)                                                                                                                                       |
| `advanced.pathToClaudeCodeExecutable` | string             | Path to the Claude Code executable. Default: auto-detect `claude`, then `claude-internal`, else SDK-bundled Claude Code (cli.js).                                                                                                       |
| `advanced.mcpServers`                 | object             | MCP server configurations keyed by server name. Default: none                                                                                                                                                                           |
| `advanced.sandbox`                    | object             | Sandbox behavior config object. This controls sandbox behavior, not the actual Read/Edit/WebFetch permission rules. Default: SDK/Claude Code default                                                                                    |
| `advanced.fallbackModel`              | string             | Fallback model if the primary model fails or is unavailable. Default: none                                                                                                                                                              |
| `advanced.enableFileCheckpointing`    | boolean            | Enable file checkpointing to track file changes during the session. Default: `false`                                                                                                                                                    |
| `advanced.toolConfig`                 | object             | Per-tool built-in configuration. Example: `{ askUserQuestion: { previewFormat: "html" } }`. Default: none                                                                                                                               |
| `advanced.includePartialMessages`     | boolean            | When true, includes intermediate streaming messages in the response. Useful for real-time progress monitoring. Default: false                                                                                                           |
| `advanced.promptSuggestions`          | boolean            | When true, emits post-turn prompt suggestion events (`prompt_suggestion`). Default: `false`                                                                                                                                             |
| `advanced.agentProgressSummaries`     | boolean            | When true, emits AI-generated summaries on `system/task_progress` events for running subagents. Default: `false`                                                                                                                        |
| `advanced.strictMcpConfig`            | boolean            | Enforce strict validation of MCP server configurations. Default: `false`                                                                                                                                                                |
| `advanced.settings`                   | string \| object   | Extra Claude Code flag settings. Pass either a path to a settings JSON file or an inline settings object. These load at the highest-priority flag-settings layer. Default: none                                                         |
| `advanced.settingSources`             | string[]           | Which filesystem settings to load. Defaults to `["user", "project", "local"]` (loads all settings and CLAUDE.md). Pass `[]` for SDK isolation mode                                                                                      |
| `advanced.debug`                      | boolean            | Enable debug mode for verbose logging. Default: `false`                                                                                                                                                                                 |
| `advanced.debugFile`                  | string             | Write debug logs to a specific file path (implicitly enables debug mode). Default: omitted                                                                                                                                              |
| `advanced.env`                        | object             | Environment variables merged over `process.env` before launching Claude Code (user values take precedence). Default: inherit `process.env`                                                                                              |

</details>

**Returns:** `{ sessionId, status: "running", pollInterval, resumeToken? }`

Notes:

- `resumeToken` is omitted by default, and is only returned when `CLAUDE_CODE_MCP_RESUME_SECRET` is set on the server.
- On error: `{ sessionId: "", status: "error", error }`
- `model` is optional. If omitted, Claude Code chooses the effective model from its own defaults/settings; inspect session/result metadata if you need to know what actually ran.
- If you plan to continue with `claude_code_reply`, keep the session persistent (`advanced.persistSession=true`, which is already the default).

Use `claude_code_check` to poll events and obtain the final `result`.

> Notes:
>
> - **Subagents require the `Task` tool** to be available to the primary agent. If you use `allowedTools`, include `"Task"` or the agent will be unable to invoke subagents.
> - If you configure `advanced.mcpServers` and want the agent to auto-use tools from those servers without approvals, include the exact tool names in `allowedTools` (e.g. `["mcp__my_server__tools/list"]`). Otherwise you will see permission requests via `claude_code_check`.
> - `advanced.includePartialMessages` affects the underlying SDK event stream; intermediate messages are captured as events and returned via `claude_code_check` (the `claude_code` call itself does not stream).

> **Security: Configure permissions based on your own scope.** Callers (MCP clients / orchestrating agents) MUST set `allowedTools` and `disallowedTools` according to their own permission boundaries. Only pre-approve tools that you yourself are authorized to perform — do not grant the agent broader permissions than you have. For example, if you lack write access to a directory, do not include `Write`/`Edit` in `allowedTools`. When in doubt, leave both lists empty and review each permission request individually via `claude_code_check`.

### `claude_code_reply` — Continue a session

Continue an existing session by sending a follow-up message. The agent retains full context from previous turns including files read, code analysis, and conversation history.

Important protocol note: prefer `claude_code_reply` over starting a fresh `claude_code` session when you want to continue the same work. This requires a persistent in-memory session, or `diskResumeConfig` when disk resume fallback is enabled.

| Parameter                    | Type    | Required | Description                                                                                                                                                                                                          |
| ---------------------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`                  | string  | Yes      | Session ID from a previous `claude_code` call                                                                                                                                                                        |
| `prompt`                     | string  | Yes      | Follow-up prompt                                                                                                                                                                                                     |
| `forkSession`                | boolean | No       | Create a branched copy of this session. Default: `false`                                                                                                                                                             |
| `effort`                     | string  | No       | Effort string override for this run (and for future replies when not forking): `"low"`, `"medium"`, `"high"`, `"max"`. Default: SDK/Claude Code default                                                              |
| `thinking`                   | object  | No       | Thinking config object override for this run (and for future replies when not forking): `{ type: "adaptive" }`, `{ type: "enabled", budgetTokens?: N }`, or `{ type: "disabled" }`. Default: SDK/Claude Code default |
| `permissionRequestTimeoutMs` | number  | No       | Timeout in milliseconds waiting for permission decisions, auto-deny on expiry. Default: `60000` (server-clamped to 5min)                                                                                             |
| `sessionInitTimeoutMs`       | number  | No       | Fork init timeout in milliseconds (only when `forkSession=true`). Default: `10000`                                                                                                                                   |
| `diskResumeConfig`           | object  | No       | Disk resume parameters (see below). Used when `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1` and in-memory session is missing                                                                                                 |

<details>
<summary><code>diskResumeConfig</code> object parameters (34 disk-resume-only parameters)</summary>

| Parameter                                     | Type               | Description                                                                                                                                          |
| --------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diskResumeConfig.resumeToken`                | string             | Resume token returned by `claude_code` / `claude_code_reply`. Required for disk resume fallback                                                      |
| `diskResumeConfig.cwd`                        | string             | Working directory. Required for disk resume.                                                                                                         |
| `diskResumeConfig.allowedTools`               | string[]           | Auto-approved tool names (see `claude_code`). Default: `[]`                                                                                          |
| `diskResumeConfig.disallowedTools`            | string[]           | Forbidden tool names (see `claude_code`). Default: `[]`                                                                                              |
| `diskResumeConfig.strictAllowedTools`         | boolean            | Server-side strict allow-list behavior for `allowedTools`. Default: `false`                                                                          |
| `diskResumeConfig.tools`                      | string[] \| object | Base tool set (see `claude_code`). Default: SDK/Claude Code default                                                                                  |
| `diskResumeConfig.persistSession`             | boolean            | Persist session history to disk. Default: `true`                                                                                                     |
| `diskResumeConfig.maxTurns`                   | number             | Maximum number of agent reasoning steps. Default: SDK/Claude Code default                                                                            |
| `diskResumeConfig.model`                      | string             | Model to use. Default: SDK/Claude Code default                                                                                                       |
| `diskResumeConfig.systemPrompt`               | string \| object   | Override the agent's system prompt. Default: SDK/Claude Code default                                                                                 |
| `diskResumeConfig.agents`                     | object             | Custom sub-agent definitions (see `claude_code`). Default: none                                                                                      |
| `diskResumeConfig.agent`                      | string             | Primary agent name (see `claude_code` tool). Default: omitted                                                                                        |
| `diskResumeConfig.maxBudgetUsd`               | number             | Maximum budget in USD. Default: SDK/Claude Code default                                                                                              |
| `diskResumeConfig.effort`                     | string             | Effort level. Default: SDK/Claude Code default                                                                                                       |
| `diskResumeConfig.betas`                      | string[]           | Beta features. Default: none                                                                                                                         |
| `diskResumeConfig.additionalDirectories`      | string[]           | Additional directories. Default: none                                                                                                                |
| `diskResumeConfig.outputFormat`               | object             | Structured output config. Default: omitted (plain text)                                                                                              |
| `diskResumeConfig.thinking`                   | object             | Thinking config object: `{ type: "adaptive" }`, `{ type: "enabled", budgetTokens?: N }`, or `{ type: "disabled" }`. Default: SDK/Claude Code default |
| `diskResumeConfig.resumeSessionAt`            | string             | Resume only up to and including a specific message UUID. Default: omitted                                                                            |
| `diskResumeConfig.pathToClaudeCodeExecutable` | string             | Path to Claude Code executable. Default: auto-detect `claude`, then `claude-internal`, else SDK-bundled Claude Code (cli.js)                         |
| `diskResumeConfig.mcpServers`                 | object             | MCP server configurations keyed by server name. Default: none                                                                                        |
| `diskResumeConfig.sandbox`                    | object             | Sandbox behavior config object. Default: SDK/Claude Code default                                                                                     |
| `diskResumeConfig.fallbackModel`              | string             | Fallback model. Default: none                                                                                                                        |
| `diskResumeConfig.enableFileCheckpointing`    | boolean            | Enable file checkpointing. Default: `false`                                                                                                          |
| `diskResumeConfig.toolConfig`                 | object             | Per-tool built-in configuration. Default: none                                                                                                       |
| `diskResumeConfig.includePartialMessages`     | boolean            | Include intermediate streaming messages. Default: `false`                                                                                            |
| `diskResumeConfig.promptSuggestions`          | boolean            | Emit post-turn prompt suggestion events (`prompt_suggestion`). Default: `false`                                                                      |
| `diskResumeConfig.agentProgressSummaries`     | boolean            | Emit AI-generated subagent progress summaries. Default: `false`                                                                                      |
| `diskResumeConfig.strictMcpConfig`            | boolean            | Strict MCP config validation. Default: `false`                                                                                                       |
| `diskResumeConfig.settings`                   | string \| object   | Extra Claude Code flag settings (path or inline object), loaded at the highest-priority flag-settings layer. Default: none                           |
| `diskResumeConfig.settingSources`             | string[]           | Which filesystem settings to load. Default: `["user", "project", "local"]`                                                                           |
| `diskResumeConfig.debug`                      | boolean            | Debug mode. Default: `false`                                                                                                                         |
| `diskResumeConfig.debugFile`                  | string             | Debug log file path (implicitly enables debug). Default: omitted                                                                                     |
| `diskResumeConfig.env`                        | object             | Environment variables merged over `process.env` (user values override). Default: inherit process.env                                                 |

</details>

**Returns:** `{ sessionId, status: "running", pollInterval, resumeToken? }`

Notes:

- `resumeToken` is omitted by default, and is only returned when `CLAUDE_CODE_MCP_RESUME_SECRET` is set on the server.
- On error: `{ sessionId, status: "error", error }`

Use `claude_code_check` to poll events and obtain the final `result`.

Gotchas:

- Permission approvals have a timeout (default 60s via `permissionRequestTimeoutMs`) and will auto-deny; watch `actions[].expiresAt` / `actions[].remainingMs`.
- `claude_code_reply` requires a persistent session or an enabled disk-resume setup; one-shot/non-persistent sessions cannot be resumed later.
- `Read` has a per-call size cap in practice (often ~256KB); for large files use `offset`/`limit` or chunk with `Grep`.
- `Edit` with `replace_all=true` is substring replacement; if no match is found the tool returns a clear error.
- On Windows, this server normalizes common MSYS-style paths (e.g. `/d/...`, `/mnt/c/...`, `/cygdrive/c/...`, `//server/share/...`) for `cwd`, `additionalDirectories`, and tool inputs that include `file_path`.
- On Windows, POSIX home paths like `/home/user/...` are **not** rewritten to drive paths; prefer absolute Windows paths under your current `cwd` to avoid out-of-bounds permission prompts.
- On Windows, Claude Code itself needs Git Bash; set `CLAUDE_CODE_GIT_BASH_PATH` in your MCP client config if auto-detection is unreliable.
- `TeamDelete` may require members to reach `shutdown_approved` (otherwise you may see "active member" errors); cleanup can be asynchronous during shutdown.
- Skills may become available later in the same session (early calls may show "Unknown", later succeed after skills are loaded/registered).
- `toolCatalogCount` and `availableTools` are different views: catalog is server-known tools, while `availableTools` comes from each session's runtime `system/init.tools`.
- Some internal features (e.g. ToolSearch) may not appear in `availableTools` (derived from SDK `system/init.tools`).

### Resources

If your MCP client supports resources, this server exposes a couple of **read-only** MCP resources:

- `claude-code-mcp:///server-info` (JSON): server metadata (version/platform/runtime + capabilities/limits)
- `claude-code-mcp:///internal-tools` (JSON): internal tool catalog (runtime-aware, includes permission/schema metadata)
- `claude-code-mcp:///gotchas` (Markdown): practical limits/gotchas
- `claude-code-mcp:///quickstart` (Markdown): minimal async start/poll/respond flow
- `claude-code-mcp:///errors` (JSON): structured error-code catalog and remediation hints
- `claude-code-mcp:///compat-report` (JSON): compatibility report (transport/platform assumptions, runtime warnings, guidance, recommended settings, tool count diagnostics)

Resource templates:

- `claude-code-mcp:///session/{sessionId}`: lightweight session snapshot for a specific session
- `claude-code-mcp:///tools/runtime{?sessionId}`: runtime tool view globally or per session
- `claude-code-mcp:///compat/diff{?client}`: client-specific compatibility guidance

**Disk resume (optional):** By default, `claude_code_reply` requires the session to exist in the MCP server's in-memory Session Manager. If you set `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`, it can attempt to resume using the Claude Code CLI's on-disk transcript even when the in-memory session is missing (e.g. after a restart / TTL cleanup). For safety, disk resume fallback requires `CLAUDE_CODE_MCP_RESUME_SECRET` to be set on the server and requires callers to pass `diskResumeConfig.resumeToken` (returned by `claude_code` / `claude_code_reply` when `CLAUDE_CODE_MCP_RESUME_SECRET` is set).

### `claude_code_session` — Manage sessions

List, inspect, cancel, or interrupt sessions.

| Parameter          | Type    | Required                 | Description                                                                                                          |
| ------------------ | ------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `action`           | string  | Yes                      | `"list"`, `"get"`, `"cancel"`, or `"interrupt"`                                                                      |
| `sessionId`        | string  | For get/cancel/interrupt | Target session ID                                                                                                    |
| `includeSensitive` | boolean | No                       | Include `cwd`/`systemPrompt`/`agents`/`additionalDirectories`/`toolConfig` (default: false; `settings` stays hidden) |

**Returns:** `{ sessions, message?, isError? }`

`sessions[]` now includes lightweight diagnostics fields: `pendingPermissionCount`, `eventCount`, `currentCursor`, `lastEventId`, `ttlMs`, `lastError?`, `lastErrorAt?`, `fastModeState?`, and `redactions[]`.

### `claude_code_check` — Poll events and respond to permission requests

Poll session events/results and approve/deny pending permission requests.

Important protocol note: `action="poll"` is the main loop, and `action="respond_permission"` is the only interactive approval flow on this backend. `respond_user_input` is not supported.

| Parameter           | Type    | Required               | Description                                                                                                               |
| ------------------- | ------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `action`            | string  | Yes                    | `"poll"` or `"respond_permission"`                                                                                        |
| `sessionId`         | string  | Yes                    | Target session ID                                                                                                         |
| `cursor`            | number  | No                     | Event cursor for incremental polling (`poll` only). Default: omitted (starts from the beginning of the buffer)            |
| `responseMode`      | string  | No                     | `"minimal"` (default), `"delta_compact"` (lightweight polling), or `"full"` (verbose diagnostics)                         |
| `maxEvents`         | number  | No                     | Max events per poll (pagination via `nextCursor`). Default: `200` in `"minimal"`; unlimited in `"full"`/`"delta_compact"` |
| `requestId`         | string  | For respond_permission | Permission request ID                                                                                                     |
| `decision`          | string  | For respond_permission | `"allow"`, `"deny"`, or `"allow_for_session"`                                                                             |
| `denyMessage`       | string  | No                     | Deny reason shown to Claude (`deny` only). Default: `"Permission denied by caller"`                                       |
| `interrupt`         | boolean | No                     | When true, denying also interrupts the whole agent (`deny` only). Default: `false`                                        |
| `pollOptions`       | object  | No                     | Fine-grained poll control options (see below)                                                                             |
| `permissionOptions` | object  | No                     | Advanced permission response options (see below)                                                                          |

<details>
<summary><code>pollOptions</code> object parameters (10 fine-grained poll controls)</summary>

| Parameter                             | Type    | Description                                                                                                                                                                                                                                               |
| ------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pollOptions.includeTools`            | boolean | When true, includes `availableTools` (`poll` only). Default: `false` (omitted until session init is received). Derived from SDK `system/init.tools` (internal features may not appear).                                                                   |
| `pollOptions.includeEvents`           | boolean | When false, omits `events` (but `nextCursor` still advances). Default: `true`                                                                                                                                                                             |
| `pollOptions.includeActions`          | boolean | When false, omits `actions[]` even if `waiting_permission`. Default: `true`                                                                                                                                                                               |
| `pollOptions.includeResult`           | boolean | When false, omits top-level `result` even when `idle`/`error`. Default: `true`                                                                                                                                                                            |
| `pollOptions.includeUsage`            | boolean | Include `result.usage` (default: `true` in `"full"`, `false` in `"minimal"`/`"delta_compact"`)                                                                                                                                                            |
| `pollOptions.includeModelUsage`       | boolean | Include `result.modelUsage` (default: `true` in `"full"`, `false` in `"minimal"`/`"delta_compact"`)                                                                                                                                                       |
| `pollOptions.includeStructuredOutput` | boolean | Include `result.structuredOutput` (default: `true` in `"full"`, `false` in `"minimal"`/`"delta_compact"`)                                                                                                                                                 |
| `pollOptions.includeTerminalEvents`   | boolean | When true, keeps terminal `result`/`error` events in `events` even if top-level `result` is included. Default: `false` in `"minimal"`/`"delta_compact"`, `true` in `"full"`                                                                               |
| `pollOptions.includeProgressEvents`   | boolean | When true, includes noisy SDK progress subtypes (e.g. `tool_progress`, `auth_status`, `system/api_retry`, `system/task_progress`, `system/hook_progress`) as MCP `progress` events. Default: `false` in `"minimal"`/`"delta_compact"`, `true` in `"full"` |
| `pollOptions.maxBytes`                | number  | Approximate max JSON bytes for `events` in this response. When exceeded, events are truncated and `truncatedFields` includes `"events_bytes"`. Default: unlimited                                                                                         |

</details>

<details>
<summary><code>permissionOptions</code> object parameters (2 advanced permission response options)</summary>

| Parameter                              | Type   | Description                                                                                 |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `permissionOptions.updatedInput`       | object | Modified tool input to run (`allow`/`allow_for_session` only). Default: none                |
| `permissionOptions.updatedPermissions` | array  | Permission rule updates suggested/applied (`allow`/`allow_for_session` only). Default: none |

</details>

**Returns (poll and respond_permission):** `{ sessionId, status, pollInterval?, cursorResetTo?, truncated?, truncatedFields?, events, nextCursor?, availableTools?, toolValidation?, compatWarnings?, actions?, result?, cancelledAt?, cancelledReason?, cancelledSource?, lastEventId?, lastToolUseId? }`

Notes:

- On error (e.g. invalid arguments, missing/expired session): `{ sessionId, isError: true, error }`
- `respond_user_input` is not supported on this backend. Use `respond_permission` for interactive approvals.
- Always treat `cursor` as an incremental position: store `nextCursor` and pass it back on the next poll to avoid replaying old events.
- If `cursorResetTo` is present, your `cursor` was too old (events were evicted); reset your cursor to `cursorResetTo`.
- For safety, de-duplicate events by `event.id` on the client side.
- If `truncated=true`, the server intentionally limited the payload (e.g. `maxEvents`) — continue polling with `nextCursor`.
- `nextCursor` can remain unchanged with `events=[]` during quiet intervals; this is normal transient behavior. Retry a few times (for example up to 3) before treating it as abnormal.
- `toolValidation` reports whether configured `allowedTools`/`disallowedTools` match runtime-discovered tool names.
- `compatWarnings` surfaces compatibility hints (for example, unresolved tool names or path/platform mismatch signals) and is **non-blocking**; treat it as advisory unless the session actually fails.
- Permission `actions[]` include `timeoutMs`, `expiresAt`, and best-effort `remainingMs` to help callers avoid auto-deny timeouts.
- Permission `actions[]` may also include SDK-provided `title` / `displayName` metadata; clients should prefer those strings when rendering approval UI.
- For `decision="allow_for_session"`, the server now prefers SDK-provided `suggestions` (for example `addDirectories`) when present, then falls back to a generic per-session tool allow rule.
- `permission_result` event data is `{ requestId, toolName, behavior, source, message?, interrupt? }` (denial details only present for `deny`).
- `result.fastModeState` may be present when the SDK reports fast-mode state, and `claude_code_session` surfaces the latest known `fastModeState` for each session.
- In `"minimal"` mode (default): assistant message events are slimmed (strips `usage`, `model`, `id`, `cache_control` from content blocks); noisy SDK progress subtypes (`tool_progress`, `auth_status`, `system/api_retry`, `system/task_progress`, `system/hook_progress`) are filtered out; `lastEventId`/`lastToolUseId` are omitted; `AgentResult` omits `durationApiMs`/`sessionTotalTurns`/`sessionTotalCostUsd`. Use `responseMode: "full"` or individual `include*` flags to restore any of these.
- In `"delta_compact"` mode: defaults minimize per-poll payload size (`events` and top-level `result` omitted unless explicitly enabled via `pollOptions`), while still returning session status/actions/cursors. Note: this does not change the recommended poll interval — `running` sessions should still be polled at >=2 minute intervals.

## Usage Example

```python
# 1) Start a new session (async start)
start = await mcp.call_tool("claude_code", {
    "prompt": "Fix the authentication bug in src/auth.ts",
    "cwd": "/path/to/project",
    "allowedTools": ["Read", "Edit", "Bash", "Glob", "Grep"],
    "effort": "high",
    "advanced": {
        "maxBudgetUsd": 5.0
    }
})
session_id = json.loads(start)["sessionId"]
cursor = 0

# 2) Poll until idle/error/cancelled
while True:
    polled = await mcp.call_tool("claude_code_check", {
        "action": "poll",
        "sessionId": session_id,
        "cursor": cursor,
        "pollOptions": {
            "includeProgressEvents": True
        }
    })
    data = json.loads(polled)
    cursor = data.get("nextCursor", cursor)

    # If permission is needed, approve/deny via respond_permission
    for action in data.get("actions", []) or []:
        if action.get("type") == "permission":
            await mcp.call_tool("claude_code_check", {
                "action": "respond_permission",
                "sessionId": session_id,
                "requestId": action["requestId"],
                "decision": "allow"
            })

    # Final result is available when status becomes idle/error
    if data.get("status") in ["idle", "error", "cancelled"]:
        final_result = data.get("result")
        break

# 3) Manage sessions (list/get/cancel/interrupt)
result = await mcp.call_tool("claude_code_session", {"action": "list"})
```

## Windows Support

The Claude Code CLI bundled in the SDK requires **Git for Windows** (which includes `bash.exe`). If you run this MCP server on Windows and see:

```
Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win).
```

This means the spawned CLI process cannot locate `bash.exe`. Your locally installed `claude` command may work fine — the issue is that the MCP server's child process may not inherit your shell environment.

`claude-code-mcp` will try to auto-detect Git Bash from common install locations and set `CLAUDE_CODE_GIT_BASH_PATH` for child processes. If you still see this error, set `CLAUDE_CODE_GIT_BASH_PATH` explicitly in your MCP server config:

For JSON-based MCP clients (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "npx",
      "args": ["-y", "@leo000001/claude-code-mcp"],
      "env": {
        "CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe"
      }
    }
  }
}
```

For OpenCode (`opencode.json` / `opencode.jsonc`):

```json
{
  "mcp": {
    "claude-code": {
      "type": "local",
      "command": ["npx", "-y", "@leo000001/claude-code-mcp"],
      "enabled": true,
      "environment": {
        "CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe"
      }
    }
  }
}
```

For OpenAI Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.claude-code-mcp]
command = "npx"
args = ["-y", "@leo000001/claude-code-mcp"]

[mcp_servers.claude-code-mcp.env]
CLAUDE_CODE_GIT_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe"
```

> Replace the path with your actual `bash.exe` location. Common paths:
>
> - `C:\Program Files\Git\bin\bash.exe` (default installer)
>
> To find yours: `where git` in CMD/PowerShell, then look for `bash.exe` under the same Git root's `bin\` folder.

Alternatively, set the environment variable system-wide so all processes inherit it:

```powershell
# PowerShell (permanent, requires new terminal)
setx CLAUDE_CODE_GIT_BASH_PATH "C:\Program Files\Git\bin\bash.exe"
```

## Security

- **Async permission approvals** — when a tool call needs approval, the session transitions to `waiting_permission` and surfaces requests via `claude_code_check` (`actions[]`).
- **No runtime privilege escalation tool** — permission decisions are per-session (allow/deny lists + explicit approvals), and the server does not expose a `claude_code_configure` bypass switch.
- **Environment variables are inherited** — the spawned Claude Code process inherits all environment variables (including `ANTHROPIC_API_KEY`) from the parent process by default. The `advanced.env` parameter **merges** with `process.env` (user-provided values take precedence), so you can safely add or override individual variables without losing existing ones.
- **Permission policy is enforced in two places** — `allowedTools`/`disallowedTools` are passed to the SDK and also guarded in `canUseTool` as a defensive consistency check (for example, `blockedPath` can still trigger an approval flow).
- Tool visibility vs approvals:
  - Use `advanced.tools` to restrict which tools the agent can _see_ (hidden tools cannot be called).
  - Use `allowedTools` to auto-approve specific tools without prompting (the SDK may still prompt for path-based restrictions like `blockedPath`).
  - Use `disallowedTools` to hard-block tools; they are denied even if later approved via `claude_code_check`.
- `maxTurns` and `advanced.maxBudgetUsd` prevent runaway execution.
- Sessions auto-expire after 30 minutes of inactivity.
- Vulnerability reporting: see `SECURITY.md`.

## Environment Variables

All environment variables are optional. They are set on the MCP server process (not on the Claude Code child process — for that, use the `env` tool parameter).

| Variable                                     | Description                                                                                                                                                                           | Default        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `CLAUDE_CODE_GIT_BASH_PATH`                  | Path to `bash.exe` on Windows (see [Windows Support](#windows-support))                                                                                                               | Auto-detected  |
| `CLAUDE_CODE_MCP_DEFAULT_CLAUDE_COMMAND`     | Exact command name to resolve from `PATH` as the default Claude executable (for example `claude` or `claude-internal`). Mutually exclusive with `CLAUDE_CODE_MCP_DEFAULT_CLAUDE_PATH` | _(unset)_      |
| `CLAUDE_CODE_MCP_DEFAULT_CLAUDE_PATH`        | Explicit filesystem path to use as the default Claude executable. Mutually exclusive with `CLAUDE_CODE_MCP_DEFAULT_CLAUDE_COMMAND`                                                    | _(unset)_      |
| `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME`          | Set to `1` to allow `claude_code_reply` to resume from on-disk transcripts when the in-memory session is missing                                                                      | `0` (disabled) |
| `CLAUDE_CODE_MCP_RESUME_SECRET`              | HMAC secret used to validate `resumeToken` for disk resume fallback (recommended if disk resume is enabled)                                                                           | _(unset)_      |
| `CLAUDE_CODE_MCP_MAX_SESSIONS`               | Maximum number of in-memory sessions (set `0` to disable the limit)                                                                                                                   | `128`          |
| `CLAUDE_CODE_MCP_MAX_PENDING_PERMISSIONS`    | Maximum number of outstanding permission requests per session (set `0` to disable the limit)                                                                                          | `64`           |
| `CLAUDE_CODE_MCP_EVENT_BUFFER_MAX_SIZE`      | Soft limit for in-memory event buffer per session (`0` is not supported)                                                                                                              | `1000`         |
| `CLAUDE_CODE_MCP_EVENT_BUFFER_HARD_MAX_SIZE` | Hard limit for in-memory event buffer per session (clamped to be `>= max`; `0` is not supported)                                                                                      | `2000`         |

### Choosing the default Claude executable

- `CLAUDE_CODE_MCP_DEFAULT_CLAUDE_PATH` and `CLAUDE_CODE_MCP_DEFAULT_CLAUDE_COMMAND` are mutually exclusive.
- If neither is set, the server auto-detects `claude`, then `claude-internal`, then falls back to the SDK-bundled CLI.
- Request-level `pathToClaudeCodeExecutable` still overrides these server defaults.
- Invalid values for these env vars are treated as startup misconfiguration and will fail the server fast.

### How to configure

**JSON-based MCP clients** (Claude Desktop, Cursor, etc.) — add an `"env"` block:

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "npx",
      "args": ["-y", "@leo000001/claude-code-mcp"],
      "env": {
        "CLAUDE_CODE_MCP_ALLOW_DISK_RESUME": "1",
        "CLAUDE_CODE_MCP_RESUME_SECRET": "change-me"
      }
    }
  }
}
```

**OpenAI Codex CLI** — add an `[mcp_servers.claude-code-mcp.env]` section in `~/.codex/config.toml`:

```toml
[mcp_servers.claude-code-mcp]
command = "npx"
args = ["-y", "@leo000001/claude-code-mcp"]

[mcp_servers.claude-code-mcp.env]
CLAUDE_CODE_MCP_ALLOW_DISK_RESUME = "1"
CLAUDE_CODE_MCP_RESUME_SECRET = "change-me"
```

**OpenCode** — add an `environment` block under the local MCP entry:

```json
{
  "mcp": {
    "claude-code": {
      "type": "local",
      "command": ["npx", "-y", "@leo000001/claude-code-mcp"],
      "enabled": true,
      "environment": {
        "CLAUDE_CODE_MCP_ALLOW_DISK_RESUME": "1",
        "CLAUDE_CODE_MCP_RESUME_SECRET": "change-me"
      }
    }
  }
}
```

**System-wide** — set via your shell profile or OS settings so all processes inherit them:

```bash
# bash / zsh
export CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1
export CLAUDE_CODE_MCP_RESUME_SECRET=change-me

# PowerShell (permanent, requires new terminal)
setx CLAUDE_CODE_MCP_ALLOW_DISK_RESUME 1
setx CLAUDE_CODE_MCP_RESUME_SECRET change-me
```

## Development

```bash
npm install          # Install dependencies
npm run build        # Build with tsup
npm run typecheck    # Type check with tsc
npm test             # Run tests with vitest
npm run dev          # Watch mode build
```

### E2E regression commands

```bash
# Run cancel->poll regression loop (single mode)
npm run e2e:stdio:cancel

# Run waiting_permission + cancel regression loop
npm run e2e:stdio:cancel:wp

# Run both modes and output one summary report
npm run e2e:stdio:runner
```

### E2E notes (Codex and other clients)

- Some clients do not expose `tools/list` directly in the chat loop. In those clients, treat "tool is callable" as the primary discovery signal, and use `tools/list` only when available.
- `allowedTools: ["Read", "Write"]` does not guarantee the model will never attempt `Bash`. For deterministic smoke tests, add `disallowedTools: ["Bash"]` and state "do not use Bash" in the prompt.
- For `claude_code_session(action="get", includeSensitive=true)`, only assert fields that were actually configured. Optional fields that were never set may be omitted.
- If a client reports `Transport closed` during E2E cleanup, reconnect the MCP server first, then run `claude_code_session(action="list")` and cancel any remaining `running` / `waiting_permission` sessions.

For an end-to-end local test plan (third-party CLI/client integration + real coding tasks), see `docs/E2E_LOCAL_TEST_PLAN.md`.

## Architecture

```
MCP Client ←→ (stdio/JSON-RPC) ←→ MCP Server     [same machine]
                                      ├── Session Manager (Map<id, state>)
                                      └── Claude Agent SDK (query())
```

**Session persistence:** The MCP server's Session Manager holds **in-memory** session metadata, a snapshot of session options (tool config, limits, `cwd`, allow/deny lists, etc.), and an event buffer used by `claude_code_check`. This metadata is **not** persisted to disk by the MCP server. The actual conversation history is persisted to disk by the Claude Code CLI (under `~/.claude/projects/`) — this is managed by the SDK, not by this MCP server. By default, if the MCP server restarts or the session expires from memory, `claude_code_reply` will return `SESSION_NOT_FOUND` even though the CLI transcript may still exist on disk. You can opt into disk-resume behavior by setting `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`.

Sessions are automatically cleaned up after 30 minutes of idle time, or after 4 hours of continuous running (timed-out running sessions transition to `cancelled`).

**Turn/Cost semantics:** `numTurns` and `totalCostUsd` are per-call increments. For cumulative per-session totals, use `sessionTotalTurns` and `sessionTotalCostUsd`. When `forkSession=true`, the returned `sessionId` (and `sessionTotal*`) refer to the forked session; the original session totals are preserved.

## Error Codes

MCP server validation/policy errors are returned as `Error [CODE]: message` where `CODE` is one of:

- `INVALID_ARGUMENT` — invalid inputs (e.g. missing sessionId, empty cwd)
- `SESSION_NOT_FOUND` — session not found in memory (expired or server restarted)
- `SESSION_BUSY` — session currently running
- `PERMISSION_DENIED` — operation not allowed by server policy
- `PERMISSION_REQUEST_NOT_FOUND` — permission request ID not found (already finished or expired)
- `RESOURCE_EXHAUSTED` — resource limit reached (e.g. max sessions or max pending permissions)
- `TIMEOUT` — operation timed out
- `CANCELLED` — session was cancelled
- `INTERNAL` — unexpected error or protocol mismatch

For Claude Agent SDK execution failures, also check `errorSubtype` (e.g. `error_max_turns`, `error_max_budget_usd`, `error_during_execution`) and the returned `result` text.

## License

MIT — see [LICENSE](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

- [Security Policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Third-party Notices](NOTICE.md)
