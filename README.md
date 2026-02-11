# claude-code-mcp

[![npm version](https://img.shields.io/npm/v/@leo000001/claude-code-mcp.svg)](https://www.npmjs.com/package/@leo000001/claude-code-mcp)
[![license](https://img.shields.io/npm/l/@leo000001/claude-code-mcp.svg)](https://github.com/xihuai18/claude-code-mcp/blob/HEAD/LICENSE)
[![node](https://img.shields.io/node/v/@leo000001/claude-code-mcp.svg)](https://nodejs.org)

MCP server that wraps [Claude Code (Claude Agent SDK)](https://docs.anthropic.com/en/docs/claude-code/overview) as tools, enabling any MCP client to invoke Claude Code for autonomous coding tasks.

Inspired by the [Codex MCP](https://developers.openai.com/codex/guides/agents-sdk/) design philosophy — minimum tools, maximum capability.

## Features

- **4 tools** covering the full agent lifecycle: start, continue, manage, configure
- **Session management** with resume and fork support
- **Local settings loaded by default** — automatically reads `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, and `CLAUDE.md` so the agent behaves like your local Claude Code CLI
- **Fine-grained permissions** — tool allow/deny lists, permission modes
- **Custom subagents** — define specialized agents per session
- **Cost tracking** — per-session turn and cost accounting
- **Session cancellation** via AbortController
- **Auto-cleanup** — 30-minute idle timeout for expired sessions
- **Security** — `bypassPermissions` disabled by default

## Prerequisites

- **Node.js >= 18** is required.

This MCP server uses the [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) package, which **bundles its own Claude Code CLI** (`cli.js`). It does not use the `claude` binary from your system PATH.

- The SDK's bundled CLI version is determined by the SDK package version (e.g. SDK 0.2.38 = Claude Code 2.1.38)
- **Configuration is shared** — the bundled CLI reads API keys and settings from `~/.claude/`, same as the system-installed `claude`
- **All local settings are loaded by default** — unlike the raw SDK (which defaults to isolation mode), this MCP server loads `user`, `project`, and `local` settings automatically, including `CLAUDE.md` project context. Pass `settingSources: []` to opt out
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

### OpenAI Codex CLI

```bash
codex mcp add claude-code -- npx -y @leo000001/claude-code-mcp
```

Or manually add to `~/.codex/config.toml`:

```toml
[mcp_servers.claude-code]
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

| Parameter                    | Type               | Required | Description                                                                                                                                        |
| ---------------------------- | ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                     | string             | Yes      | Task or question for Claude Code                                                                                                                   |
| `cwd`                        | string             | No       | Working directory (defaults to server cwd)                                                                                                         |
| `allowedTools`               | string[]           | No       | List of tool names the agent can use without permission prompts. In `"dontAsk"` mode, only tools in this list are available. Example: `["Bash", "Read", "Write", "Edit"]` |
| `disallowedTools`            | string[]           | No       | List of tool names the agent is forbidden from using. Takes precedence over `allowedTools`                                                         |
| `tools`                      | string[] \| object | No       | Define the base tool set. Array of tool name strings, or `{ type: "preset", preset: "claude_code" }` for the default toolset. `allowedTools`/`disallowedTools` further filter on top of this |
| `persistSession`             | boolean            | No       | Persist session history to disk (`~/.claude/projects/`). Default: `true`. Set `false` to disable.                                                  |
| `permissionMode`             | string             | No       | Controls how the agent handles tool permissions. Defaults to `"dontAsk"`. Options: `"default"`, `"acceptEdits"`, `"bypassPermissions"`, `"plan"`, `"delegate"`, `"dontAsk"` |
| `maxTurns`                   | number             | No       | Maximum number of agent reasoning steps. Each step may involve one or more tool calls                                                              |
| `model`                      | string             | No       | Model to use (e.g. `"claude-sonnet-4-5-20250929"`)                                                                                                 |
| `systemPrompt`               | string \| object   | No       | Override the agent's system prompt. Pass a string for full replacement, or `{ type: "preset", preset: "claude_code", append?: "..." }` to extend the default prompt |
| `agents`                     | object             | No       | Define custom sub-agents the main agent can delegate tasks to. Each key is the agent name; value specifies prompt, tools, model, etc.              |
| `maxBudgetUsd`               | number             | No       | Maximum budget in USD                                                                                                                              |
| `timeout`                    | number             | No       | Timeout in milliseconds for this session                                                                                                           |
| `effort`                     | string             | No       | Effort level: `"low"`, `"medium"`, `"high"`, `"max"`                                                                                               |
| `betas`                      | string[]           | No       | Beta features (e.g. `["context-1m-2025-08-07"]`)                                                                                                   |
| `additionalDirectories`      | string[]           | No       | Additional directories the agent can access beyond cwd                                                                                             |
| `outputFormat`               | object             | No       | Structured output: `{ type: "json_schema", schema: {...} }`. Omit for plain text                                                                   |
| `thinking`                   | object             | No       | Thinking mode: `{ type: "adaptive" }`, `{ type: "enabled", budgetTokens: N }`, or `{ type: "disabled" }`                                           |
| `pathToClaudeCodeExecutable` | string             | No       | Path to a custom Claude Code executable                                                                                                            |
| `agent`                      | string             | No       | Name of a custom agent (defined in `agents`) to use as the primary agent, applying its system prompt, tool restrictions, and model                  |
| `mcpServers`                 | object             | No       | MCP server configurations (key: server name, value: server config)                                                                                 |
| `sandbox`                    | object             | No       | Sandbox configuration for isolating shell command execution (e.g., Docker container settings)                                                      |
| `fallbackModel`              | string             | No       | Fallback model if the primary model fails or is unavailable                                                                                        |
| `enableFileCheckpointing`    | boolean            | No       | Enable file checkpointing to track file changes during the session                                                                                 |
| `includePartialMessages`     | boolean            | No       | When true, includes intermediate streaming messages in the response. Useful for real-time progress monitoring. Default: false                       |
| `strictMcpConfig`            | boolean            | No       | Enforce strict validation of MCP server configurations                                                                                             |
| `settingSources`             | string[]           | No       | Which filesystem settings to load. Defaults to `["user", "project", "local"]` (loads all settings and CLAUDE.md). Pass `[]` for SDK isolation mode |
| `debug`                      | boolean            | No       | Enable debug mode for verbose logging                                                                                                              |
| `debugFile`                  | string             | No       | Write debug logs to a specific file path (implicitly enables debug mode)                                                                           |
| `env`                        | object             | No       | Environment variables passed to the Claude Code process                                                                                            |

**Returns:** `{ sessionId, result, isError, durationMs, durationApiMs?, numTurns, totalCostUsd, sessionTotalTurns?, sessionTotalCostUsd?, structuredOutput?, stopReason?, errorSubtype?, usage?, modelUsage?, permissionDenials? }`

> Notes:
> - **Subagents require the `Task` tool** to be available to the primary agent. If you use `allowedTools`, include `"Task"` or the agent will be unable to invoke subagents.
> - If you configure `mcpServers` and want the agent to call tools from those servers, you must also allow them via `allowedTools` (e.g. `"mcp__my_server__*"` or specific tool names), especially in `permissionMode="dontAsk"`.
> - `includePartialMessages` affects the underlying SDK event stream, but **this MCP server returns a single final JSON result** (it does not stream intermediate events over MCP responses).

### `claude_code_reply` — Continue a session

Continue an existing session by sending a follow-up message. The agent retains full context from previous turns including files read, code analysis, and conversation history.

| Parameter     | Type    | Required | Description                                   |
| ------------- | ------- | -------- | --------------------------------------------- |
| `sessionId`   | string  | Yes      | Session ID from a previous `claude_code` call |
| `prompt`      | string  | Yes      | Follow-up prompt                              |
| `forkSession` | boolean | No       | Create a branched copy of this session. The original remains unchanged; the new session diverges from this point |
| `timeout`     | number  | No       | Timeout in milliseconds for this reply        |

<details>
<summary>Disk resume parameters (used when <code>CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1</code> and in-memory session is missing)</summary>

| Parameter                    | Type               | Description                                         |
| ---------------------------- | ------------------ | --------------------------------------------------- |
| `cwd`                        | string             | Working directory                                   |
| `allowedTools`               | string[]           | Auto-approved tool names (see `claude_code` tool)   |
| `disallowedTools`            | string[]           | Forbidden tool names (see `claude_code` tool)       |
| `tools`                      | string[] \| object | Base tool set (see `claude_code` tool)              |
| `persistSession`             | boolean            | Persist session history to disk                     |
| `permissionMode`             | string             | Permission mode                                     |
| `maxTurns`                   | number             | Maximum number of agent reasoning steps             |
| `model`                      | string             | Model to use                                        |
| `systemPrompt`               | string \| object   | Override the agent's system prompt                  |
| `agents`                     | object             | Custom sub-agent definitions (see `claude_code`)    |
| `maxBudgetUsd`               | number             | Maximum budget in USD                               |
| `effort`                     | string             | Effort level                                        |
| `betas`                      | string[]           | Beta features                                       |
| `additionalDirectories`      | string[]           | Additional directories                              |
| `outputFormat`               | object             | Structured output format                            |
| `thinking`                   | object             | Thinking mode                                       |
| `resumeSessionAt`            | string             | Resume up to a specific message UUID                |
| `pathToClaudeCodeExecutable` | string             | Path to Claude Code executable                      |
| `agent`                      | string             | Primary agent name (see `claude_code` tool)         |
| `mcpServers`                 | object             | MCP server configurations                           |
| `sandbox`                    | object             | Sandbox config for command isolation                |
| `fallbackModel`              | string             | Fallback model                                      |
| `enableFileCheckpointing`    | boolean            | Enable file checkpointing                           |
| `includePartialMessages`     | boolean            | Include intermediate streaming messages             |
| `strictMcpConfig`            | boolean            | Strict MCP config validation                        |
| `settingSources`             | string[]           | Which filesystem settings to load (defaults to all) |
| `debug`                      | boolean            | Debug mode                                          |
| `debugFile`                  | string             | Debug log file path                                 |
| `env`                        | object             | Environment variables                               |

</details>

**Returns:** `{ sessionId, result, isError, durationMs, durationApiMs?, numTurns, totalCostUsd, sessionTotalTurns?, sessionTotalCostUsd?, structuredOutput?, stopReason?, errorSubtype?, usage?, modelUsage?, permissionDenials? }`

**Disk resume (optional):** By default, `claude_code_reply` requires the session to exist in the MCP server's in-memory Session Manager. If you set `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`, it will attempt to resume using the Claude Code CLI's on-disk transcript even when the in-memory session is missing (e.g. after a restart / TTL cleanup). In that mode, you may also pass the session options listed in the collapsible table above, which are otherwise ignored when the in-memory session exists.

### `claude_code_session` — Manage sessions

List, inspect, or cancel sessions.

| Parameter          | Type    | Required       | Description                                                                                                                                  |
| ------------------ | ------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`           | string  | Yes            | `"list"`, `"get"`, or `"cancel"`                                                                                                             |
| `sessionId`        | string  | For get/cancel | Target session ID                                                                                                                            |
| `includeSensitive` | boolean | No             | Include `cwd`/`systemPrompt`/`agents`/`additionalDirectories` (default: false; requires `CLAUDE_CODE_MCP_ALLOW_SENSITIVE_SESSION_DETAILS=1`) |

**Returns:** `{ sessions, message?, isError? }`

### `claude_code_configure` — Runtime configuration

Enable or disable `bypassPermissions` mode at runtime without restarting the server.

| Parameter | Type   | Required | Description                                              |
| --------- | ------ | -------- | -------------------------------------------------------- |
| `action`  | string | Yes      | `"enable_bypass"`, `"disable_bypass"`, or `"get_config"` |

**Returns:** `{ allowBypass, message, isError? }`

## Usage Example

```python
# 1. Start a new session
result = await mcp.call_tool("claude_code", {
    "prompt": "Fix the authentication bug in src/auth.ts",
    "cwd": "/path/to/project",
    "allowedTools": ["Read", "Edit", "Bash", "Glob", "Grep"],
    "permissionMode": "acceptEdits"
})
session_id = json.loads(result)["sessionId"]

# 2. Continue the session
result = await mcp.call_tool("claude_code_reply", {
    "sessionId": session_id,
    "prompt": "Now add unit tests for the fix"
})

# 3. List all sessions
result = await mcp.call_tool("claude_code_session", {
    "action": "list"
})

# 4. Cancel a running session
result = await mcp.call_tool("claude_code_session", {
    "action": "cancel",
    "sessionId": session_id
})
```

## Windows Support

The Claude Code CLI bundled in the SDK requires **Git for Windows** (which includes `bash.exe`). If you run this MCP server on Windows and see:

```
Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win).
```

This means the spawned CLI process cannot locate `bash.exe`. Your locally installed `claude` command may work fine — the issue is that the MCP server's child process may not inherit your shell environment.

**Fix: set `CLAUDE_CODE_GIT_BASH_PATH` in your MCP server config.**

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

For OpenAI Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.claude-code]
command = "npx"
args = ["-y", "@leo000001/claude-code-mcp"]

[mcp_servers.claude-code.env]
CLAUDE_CODE_GIT_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe"
```

> Replace the path with your actual `bash.exe` location. Common paths:
> - `C:\Program Files\Git\bin\bash.exe` (default installer)
>
> To find yours: `where git` in CMD/PowerShell, then look for `bash.exe` under the same Git root's `bin\` folder.

Alternatively, set the environment variable system-wide so all processes inherit it:

```powershell
# PowerShell (permanent, requires new terminal)
setx CLAUDE_CODE_GIT_BASH_PATH "C:\Program Files\Git\bin\bash.exe"
```

## Security

- **`permissionMode` defaults to `"dontAsk"`** — the agent will deny any operation not pre-approved, avoiding interactive prompts that would hang in MCP context.
- **`bypassPermissions` is disabled by default.** Use the `claude_code_configure` tool with action `enable_bypass` to enable it at runtime.
- **Environment variables are inherited** — the spawned Claude Code process inherits all environment variables (including `ANTHROPIC_API_KEY`) from the parent process by default. The `env` parameter **merges** with `process.env` (user-provided values take precedence), so you can safely add or override individual variables without losing existing ones.
- Use `tools` / `disallowedTools` to restrict the base set of tools the agent can use. Use `allowedTools` to specify which tools are auto-approved without prompting.
- `maxTurns` and `maxBudgetUsd` prevent runaway execution.
- Sessions auto-expire after 30 minutes of inactivity.

## Environment Variables

All environment variables are optional. They are set on the MCP server process (not on the Claude Code child process — for that, use the `env` tool parameter).

| Variable | Description | Default |
| --- | --- | --- |
| `CLAUDE_CODE_GIT_BASH_PATH` | Path to `bash.exe` on Windows (see [Windows Support](#windows-support)) | Auto-detected |
| `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME` | Set to `1` to allow `claude_code_reply` to resume from on-disk transcripts when the in-memory session is missing | `0` (disabled) |
| `CLAUDE_CODE_MCP_ALLOW_SENSITIVE_SESSION_DETAILS` | Set to `1` to allow `claude_code_session` to return `cwd`, `systemPrompt`, `agents`, `additionalDirectories` | `0` (disabled) |
| `CLAUDE_CODE_MCP_SESSION_TTL_MS` | Idle session time-to-live in milliseconds | `1800000` (30 min) |
| `CLAUDE_CODE_MCP_RUNNING_SESSION_MAX_MS` | Maximum wall-clock time for a running session before forced cleanup | `14400000` (4 hr) |
| `CLAUDE_CODE_MCP_CLEANUP_INTERVAL_MS` | How often the cleanup timer runs | `60000` (1 min) |

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
        "CLAUDE_CODE_MCP_SESSION_TTL_MS": "3600000"
      }
    }
  }
}
```

**OpenAI Codex CLI** — add an `[mcp_servers.claude-code.env]` section in `~/.codex/config.toml`:

```toml
[mcp_servers.claude-code]
command = "npx"
args = ["-y", "@leo000001/claude-code-mcp"]

[mcp_servers.claude-code.env]
CLAUDE_CODE_MCP_ALLOW_DISK_RESUME = "1"
CLAUDE_CODE_MCP_SESSION_TTL_MS = "3600000"
```

**System-wide** — set via your shell profile or OS settings so all processes inherit them:

```bash
# bash / zsh
export CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1

# PowerShell (permanent, requires new terminal)
setx CLAUDE_CODE_MCP_ALLOW_DISK_RESUME 1
```

## Development

```bash
npm install          # Install dependencies
npm run build        # Build with tsup
npm run typecheck    # Type check with tsc
npm test             # Run tests with vitest
npm run dev          # Watch mode build
```

## Architecture

```
MCP Client ←→ (stdio/JSON-RPC) ←→ MCP Server
                                      ├── Session Manager (Map<id, state>)
                                      └── Claude Agent SDK (query())
```

**Session persistence:** The MCP server's Session Manager holds **in-memory** session metadata and a snapshot of session options (e.g. `permissionMode`, tool config, limits, `cwd`). This metadata is **not** persisted to disk by the MCP server. The actual conversation history is persisted to disk by the Claude Code CLI (under `~/.claude/projects/`) — this is managed by the SDK, not by this MCP server. By default, if the MCP server restarts or the session expires from memory, `claude_code_reply` will return `SESSION_NOT_FOUND` even though the CLI transcript may still exist on disk. You can opt into disk-resume behavior by setting `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`.

**Session cleanup tuning (optional):** Configure in-memory session cleanup with:

- `CLAUDE_CODE_MCP_SESSION_TTL_MS` (default: 1800000)
- `CLAUDE_CODE_MCP_RUNNING_SESSION_MAX_MS` (default: 14400000)
- `CLAUDE_CODE_MCP_CLEANUP_INTERVAL_MS` (default: 60000)

**Turn/Cost semantics:** `numTurns` and `totalCostUsd` are per-call increments. For cumulative per-session totals, use `sessionTotalTurns` and `sessionTotalCostUsd`. When `forkSession=true`, the returned `sessionId` (and `sessionTotal*`) refer to the forked session; the original session totals are preserved.

## Error Codes

MCP server validation/policy errors are returned as `Error [CODE]: message` where `CODE` is one of:

- `INVALID_ARGUMENT` — invalid inputs (e.g. missing sessionId, empty cwd)
- `SESSION_NOT_FOUND` — session not found in memory (expired or server restarted)
- `SESSION_BUSY` — session currently running
- `PERMISSION_DENIED` — operation not allowed by server policy
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
