# claude-code-mcp

[![npm version](https://img.shields.io/npm/v/@leo000001/claude-code-mcp.svg)](https://www.npmjs.com/package/@leo000001/claude-code-mcp)
[![license](https://img.shields.io/npm/l/@leo000001/claude-code-mcp.svg)](https://github.com/xihuai18/claude-code-mcp/blob/HEAD/LICENSE)
[![node](https://img.shields.io/node/v/@leo000001/claude-code-mcp.svg)](https://nodejs.org)

MCP server that wraps [Claude Code (Claude Agent SDK)](https://docs.anthropic.com/en/docs/claude-code/overview) as tools, enabling any MCP client to invoke Claude Code for autonomous coding tasks.

Inspired by the [Codex MCP](https://developers.openai.com/codex/guides/agents-sdk/) design philosophy — minimum tools, maximum capability.

## Features

- **4 tools** covering the full agent lifecycle: start, continue, check/poll, manage
- **Session management** with resume and fork support
- **Local settings loaded by default** — automatically reads `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, and `CLAUDE.md` so the agent behaves like your local Claude Code CLI
- **Async permissions** — allow/deny lists + explicit approvals via `claude_code_check`
- **Custom subagents** — define specialized agents per session
- **Cost tracking** — per-session turn and cost accounting
- **Session cancellation** via AbortController
- **Auto-cleanup** — 30-minute idle timeout for expired sessions
- **Security** — callers control tool permissions via allow/deny lists + explicit permission decisions

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

| Parameter                    | Type               | Required | Description                                                                                                                                                                                  |
| ---------------------------- | ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                     | string             | Yes      | Task or question for Claude Code                                                                                                                                                             |
| `cwd`                        | string             | No       | Working directory (defaults to server cwd)                                                                                                                                                   |
| `allowedTools`               | string[]           | No       | Auto-approved tool names. Default: `[]` (none). Tools not in `allowedTools`/`disallowedTools` may surface permission requests via `claude_code_check`. Example: `["Bash", "Read", "Write", "Edit"]` |
| `disallowedTools`            | string[]           | No       | Forbidden tool names. Default: `[]` (none). SDK behavior: disallowed tools are removed from the model’s context. Takes precedence over `allowedTools` and will be denied even if later approved interactively |
| `tools`                      | string[] \| object | No       | Define the base tool set. Default: SDK/Claude Code default toolset. Array of tool name strings, or `{ type: "preset", preset: "claude_code" }` for the default toolset. `allowedTools`/`disallowedTools` further filter on top of this |
| `persistSession`             | boolean            | No       | Persist session history to disk (`~/.claude/projects/`). Default: `true`. Set `false` to disable.                                                                                            |
| `sessionInitTimeoutMs`       | number             | No       | Timeout in milliseconds waiting for `system/init`. Default: `10000`                                                                                                                          |
| `permissionRequestTimeoutMs` | number             | No       | Timeout in milliseconds waiting for permission decisions. Default: `60000`                                                                                                                   |
| `maxTurns`                   | number             | No       | Maximum number of agent reasoning steps. Each step may involve one or more tool calls. Default: SDK/Claude Code default                                                                      |
| `model`                      | string             | No       | Model to use (e.g. `"claude-sonnet-4-5-20250929"`). Default: SDK/Claude Code default                                                                                                         |
| `systemPrompt`               | string \| object   | No       | Override the agent's system prompt. Default: SDK/Claude Code default. Pass a string for full replacement, or `{ type: "preset", preset: "claude_code", append?: "..." }` to extend the default prompt |
| `agents`                     | object             | No       | Define custom sub-agents the main agent can delegate tasks to. Default: none. SDK default: if a sub-agent omits `tools`, it inherits all tools from the parent.                              |
| `maxBudgetUsd`               | number             | No       | Maximum budget in USD. Default: SDK/Claude Code default                                                                                                                                      |
| `effort`                     | string             | No       | Effort level: `"low"`, `"medium"`, `"high"`, `"max"`. Default: SDK/Claude Code default                                                                                                      |
| `betas`                      | string[]           | No       | Beta features (e.g. `["context-1m-2025-08-07"]`). Default: none                                                                                                                              |
| `additionalDirectories`      | string[]           | No       | Additional directories the agent can access beyond cwd. Default: none                                                                                                                        |
| `outputFormat`               | object             | No       | Structured output: `{ type: "json_schema", schema: {...} }`. Default: omitted (plain text)                                                                                                   |
| `thinking`                   | object             | No       | Thinking mode: `{ type: "adaptive" }`, `{ type: "enabled", budgetTokens: N }`, or `{ type: "disabled" }`. Default: SDK/Claude Code default                                                  |
| `pathToClaudeCodeExecutable` | string             | No       | Path to the Claude Code executable. Default: SDK-bundled Claude Code (cli.js)                                                                                                                |
| `agent`                      | string             | No       | Name of a custom agent (defined in `agents`) to use as the primary agent. Default: omitted                                                                                                   |
| `mcpServers`                 | object             | No       | MCP server configurations (key: server name, value: server config). Default: none                                                                                                            |
| `sandbox`                    | object             | No       | Sandbox configuration for isolating shell command execution (e.g., Docker container settings). Default: SDK/Claude Code default                                                               |
| `fallbackModel`              | string             | No       | Fallback model if the primary model fails or is unavailable. Default: none                                                                                                                   |
| `enableFileCheckpointing`    | boolean            | No       | Enable file checkpointing to track file changes during the session. Default: `false`                                                                                                         |
| `includePartialMessages`     | boolean            | No       | When true, includes intermediate streaming messages in the response. Useful for real-time progress monitoring. Default: false                                                                |
| `strictMcpConfig`            | boolean            | No       | Enforce strict validation of MCP server configurations. Default: `false`                                                                                                                     |
| `settingSources`             | string[]           | No       | Which filesystem settings to load. Defaults to `["user", "project", "local"]` (loads all settings and CLAUDE.md). Pass `[]` for SDK isolation mode                                           |
| `debug`                      | boolean            | No       | Enable debug mode for verbose logging. Default: `false`                                                                                                                                      |
| `debugFile`                  | string             | No       | Write debug logs to a specific file path (implicitly enables debug mode). Default: omitted                                                                                                   |
| `env`                        | object             | No       | Environment variables to merge with process.env and pass to the Claude Code process (user values take precedence). Default: inherit process.env                                               |

**Returns:** `{ sessionId, status: "running", pollInterval, resumeToken? }`

Notes:
- `resumeToken` is omitted by default, and is only returned when `CLAUDE_CODE_MCP_RESUME_SECRET` is set on the server.
- On error: `{ sessionId: "", status: "error", error }`

Use `claude_code_check` to poll events and obtain the final `result`.

> Notes:
> - **Subagents require the `Task` tool** to be available to the primary agent. If you use `allowedTools`, include `"Task"` or the agent will be unable to invoke subagents.
> - If you configure `mcpServers` and want the agent to auto-use tools from those servers without approvals, include the exact tool names in `allowedTools` (e.g. `["mcp__my_server__tools/list"]`). Otherwise you will see permission requests via `claude_code_check`.
> - `includePartialMessages` affects the underlying SDK event stream; intermediate messages are captured as events and returned via `claude_code_check` (the `claude_code` call itself does not stream).

### `claude_code_reply` — Continue a session

Continue an existing session by sending a follow-up message. The agent retains full context from previous turns including files read, code analysis, and conversation history.

| Parameter                    | Type    | Required | Description                                                                                                      |
| ---------------------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `sessionId`                  | string  | Yes      | Session ID from a previous `claude_code` call                                                                    |
| `prompt`                     | string  | Yes      | Follow-up prompt                                                                                                 |
| `forkSession`                | boolean | No       | Create a branched copy of this session. Default: `false`                                                         |
| `resumeToken`                | string  | No       | Resume token returned by `claude_code` / `claude_code_reply`. Default: omitted (required for disk resume fallback) |
| `sessionInitTimeoutMs`       | number  | No       | Timeout in milliseconds waiting for fork `system/init`. Default: `10000`                                         |
| `permissionRequestTimeoutMs` | number  | No       | Timeout in milliseconds waiting for permission decisions. Default: `60000`                                       |

<details>
<summary>Disk resume parameters (used when <code>CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1</code> and in-memory session is missing)</summary>

| Parameter                    | Type               | Description                                         |
| ---------------------------- | ------------------ | --------------------------------------------------- |
| `cwd`                        | string             | Working directory. Required for disk resume.        |
| `allowedTools`               | string[]           | Auto-approved tool names (see `claude_code`). Default: `[]` |
| `disallowedTools`            | string[]           | Forbidden tool names (see `claude_code`). Default: `[]` |
| `tools`                      | string[] \| object | Base tool set (see `claude_code`). Default: SDK/Claude Code default |
| `persistSession`             | boolean            | Persist session history to disk. Default: `true`    |
| `maxTurns`                   | number             | Maximum number of agent reasoning steps. Default: SDK/Claude Code default |
| `model`                      | string             | Model to use. Default: SDK/Claude Code default      |
| `systemPrompt`               | string \| object   | Override the agent's system prompt. Default: SDK/Claude Code default |
| `agents`                     | object             | Custom sub-agent definitions (see `claude_code`). Default: none |
| `maxBudgetUsd`               | number             | Maximum budget in USD. Default: SDK/Claude Code default |
| `effort`                     | string             | Effort level. Default: SDK/Claude Code default      |
| `betas`                      | string[]           | Beta features. Default: none                        |
| `additionalDirectories`      | string[]           | Additional directories. Default: none               |
| `outputFormat`               | object             | Structured output format. Default: omitted (plain text) |
| `thinking`                   | object             | Thinking mode. Default: SDK/Claude Code default     |
| `resumeSessionAt`            | string             | Resume only up to and including a specific message UUID. Default: omitted |
| `pathToClaudeCodeExecutable` | string             | Path to Claude Code executable. Default: SDK-bundled Claude Code (cli.js) |
| `agent`                      | string             | Primary agent name (see `claude_code` tool). Default: omitted |
| `mcpServers`                 | object             | MCP server configurations. Default: none            |
| `sandbox`                    | object             | Sandbox config for command isolation. Default: SDK/Claude Code default |
| `fallbackModel`              | string             | Fallback model. Default: none                       |
| `enableFileCheckpointing`    | boolean            | Enable file checkpointing. Default: `false`         |
| `includePartialMessages`     | boolean            | Include intermediate streaming messages. Default: `false` |
| `strictMcpConfig`            | boolean            | Strict MCP config validation. Default: `false`      |
| `settingSources`             | string[]           | Which filesystem settings to load. Default: `["user", "project", "local"]` |
| `debug`                      | boolean            | Debug mode. Default: `false`                        |
| `debugFile`                  | string             | Debug log file path. Default: omitted               |
| `env`                        | object             | Environment variables. Default: inherit process.env (user values override) |

</details>

**Returns:** `{ sessionId, status: "running", pollInterval, resumeToken? }`

Notes:
- `resumeToken` is omitted by default, and is only returned when `CLAUDE_CODE_MCP_RESUME_SECRET` is set on the server.
- On error: `{ sessionId, status: "error", error }`

Use `claude_code_check` to poll events and obtain the final `result`.

**Disk resume (optional):** By default, `claude_code_reply` requires the session to exist in the MCP server's in-memory Session Manager. If you set `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`, it can attempt to resume using the Claude Code CLI's on-disk transcript even when the in-memory session is missing (e.g. after a restart / TTL cleanup). For safety, disk resume fallback requires `CLAUDE_CODE_MCP_RESUME_SECRET` to be set on the server and requires callers to pass `resumeToken` (returned by `claude_code` / `claude_code_reply` when `CLAUDE_CODE_MCP_RESUME_SECRET` is set).

### `claude_code_session` — Manage sessions

List, inspect, or cancel sessions.

| Parameter          | Type    | Required       | Description                                                                                                                                  |
| ------------------ | ------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`           | string  | Yes            | `"list"`, `"get"`, or `"cancel"`                                                                                                             |
| `sessionId`        | string  | For get/cancel | Target session ID                                                                                                                            |
| `includeSensitive` | boolean | No             | Include `cwd`/`systemPrompt`/`agents`/`additionalDirectories` (default: false) |

**Returns:** `{ sessions, message?, isError? }`

### `claude_code_check` — Poll events and respond to permission requests

Poll session events/results and approve/deny pending permission requests.

| Parameter                 | Type    | Required               | Description                                                                                                                |
| ------------------------- | ------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `action`                  | string  | Yes                    | `"poll"` or `"respond_permission"`                                                                                         |
| `sessionId`               | string  | Yes                    | Target session ID                                                                                                          |
| `cursor`                  | number  | No                     | Event cursor for incremental polling (`poll` only). Default: omitted (starts from the beginning of the buffer)            |
| `includeTools`            | boolean | No                     | When true, includes `availableTools` (`poll` only). Default: `false` (omitted until session init is received)              |
| `responseMode`            | string  | No                     | `"minimal"` (default) or `"full"` — controls payload size and redaction behavior                                           |
| `maxEvents`               | number  | No                     | Max events per poll (pagination via `nextCursor`). Default: `200` in `"minimal"`; unlimited in `"full"`                    |
| `includeEvents`           | boolean | No                     | When false, omits `events` (but `nextCursor` still advances). Default: `true`                                              |
| `includeActions`          | boolean | No                     | When false, omits `actions[]` even if `waiting_permission`. Default: `true`                                                |
| `includeResult`           | boolean | No                     | When false, omits top-level `result` even when `idle`/`error`. Default: `true`                                             |
| `includeUsage`            | boolean | No                     | Include `result.usage` (default: true in full mode, false in minimal mode)                                                 |
| `includeModelUsage`       | boolean | No                     | Include `result.modelUsage` (default: true in full mode, false in minimal mode)                                            |
| `includeStructuredOutput` | boolean | No                     | Include `result.structuredOutput` (default: true in full mode, false in minimal mode)                                      |
| `includeTerminalEvents`   | boolean | No                     | When true, keeps terminal `result`/`error` events in `events` even if top-level `result` is included. Default: `false` in `"minimal"`, `true` in `"full"` |
| `requestId`               | string  | For respond_permission | Permission request ID                                                                                                      |
| `decision`                | string  | For respond_permission | `"allow"` or `"deny"`                                                                                                      |
| `denyMessage`             | string  | No                     | Deny reason shown to Claude (`deny` only). Default: `"Permission denied by caller"`                                        |
| `updatedInput`            | object  | No                     | Modified tool input to run (`allow` only). Default: none                                                                   |
| `updatedPermissions`      | array   | No                     | Permission rule updates suggested/applied (`allow` only). Default: none                                                    |
| `interrupt`               | boolean | No                     | When true, denying also interrupts the whole agent (`deny` only). Default: `false`                                        |

**Returns (poll and respond_permission):** `{ sessionId, status, pollInterval?, cursorResetTo?, truncated?, truncatedFields?, events, nextCursor?, availableTools?, actions?, result?, cancelledAt?, cancelledReason?, cancelledSource?, lastEventId?, lastToolUseId? }`

Notes:

- On error (e.g. invalid arguments, missing/expired session): `{ sessionId, isError: true, error }`
- Always treat `cursor` as an incremental position: store `nextCursor` and pass it back on the next poll to avoid replaying old events.
- If `cursorResetTo` is present, your `cursor` was too old (events were evicted); reset your cursor to `cursorResetTo`.
- For safety, de-duplicate events by `event.id` on the client side.
- If `truncated=true`, the server intentionally limited the payload (e.g. `maxEvents`) — continue polling with `nextCursor`.

## Usage Example

```python
# 1) Start a new session (async start)
start = await mcp.call_tool("claude_code", {
    "prompt": "Fix the authentication bug in src/auth.ts",
    "cwd": "/path/to/project",
    "allowedTools": ["Read", "Edit", "Bash", "Glob", "Grep"]
})
session_id = json.loads(start)["sessionId"]
cursor = None

# 2) Poll until idle/error/cancelled
while True:
    polled = await mcp.call_tool("claude_code_check", {
        "action": "poll",
        "sessionId": session_id,
        "cursor": cursor
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

# 3) Manage sessions (list/get/cancel)
result = await mcp.call_tool("claude_code_session", {"action": "list"})
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

- **Async permission approvals** — when a tool call needs approval, the session transitions to `waiting_permission` and surfaces requests via `claude_code_check` (`actions[]`).
- **No runtime privilege escalation tool** — permission decisions are per-session (allow/deny lists + explicit approvals), and the server does not expose a `claude_code_configure` bypass switch.
- **Environment variables are inherited** — the spawned Claude Code process inherits all environment variables (including `ANTHROPIC_API_KEY`) from the parent process by default. The `env` parameter **merges** with `process.env` (user-provided values take precedence), so you can safely add or override individual variables without losing existing ones.
- Tool visibility vs approvals:
  - Use `tools` to restrict which tools the agent can *see* (hidden tools cannot be called).
  - Use `allowedTools` to auto-approve specific tools without prompting (the SDK may still prompt for path-based restrictions like `blockedPath`).
  - Use `disallowedTools` to hard-block tools; they are denied even if later approved via `claude_code_check`.
- `maxTurns` and `maxBudgetUsd` prevent runaway execution.
- Sessions auto-expire after 30 minutes of inactivity.

## Environment Variables

All environment variables are optional. They are set on the MCP server process (not on the Claude Code child process — for that, use the `env` tool parameter).

| Variable                                          | Description                                                                                                      | Default            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------ |
| `CLAUDE_CODE_GIT_BASH_PATH`                       | Path to `bash.exe` on Windows (see [Windows Support](#windows-support))                                          | Auto-detected      |
| `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME`               | Set to `1` to allow `claude_code_reply` to resume from on-disk transcripts when the in-memory session is missing | `0` (disabled)     |
| `CLAUDE_CODE_MCP_RESUME_SECRET`                   | HMAC secret used to validate `resumeToken` for disk resume fallback (recommended if disk resume is enabled)      | *(unset)*          |

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

**OpenAI Codex CLI** — add an `[mcp_servers.claude-code.env]` section in `~/.codex/config.toml`:

```toml
[mcp_servers.claude-code]
command = "npx"
args = ["-y", "@leo000001/claude-code-mcp"]

[mcp_servers.claude-code.env]
CLAUDE_CODE_MCP_ALLOW_DISK_RESUME = "1"
CLAUDE_CODE_MCP_RESUME_SECRET = "change-me"
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

## Architecture

```
MCP Client ←→ (stdio/JSON-RPC) ←→ MCP Server
                                      ├── Session Manager (Map<id, state>)
                                      └── Claude Agent SDK (query())
```

**Session persistence:** The MCP server's Session Manager holds **in-memory** session metadata, a snapshot of session options (tool config, limits, `cwd`, allow/deny lists, etc.), and an event buffer used by `claude_code_check`. This metadata is **not** persisted to disk by the MCP server. The actual conversation history is persisted to disk by the Claude Code CLI (under `~/.claude/projects/`) — this is managed by the SDK, not by this MCP server. By default, if the MCP server restarts or the session expires from memory, `claude_code_reply` will return `SESSION_NOT_FOUND` even though the CLI transcript may still exist on disk. You can opt into disk-resume behavior by setting `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`.

Sessions are automatically cleaned up after 30 minutes of idle time, or after 4 hours of continuous running.

**Turn/Cost semantics:** `numTurns` and `totalCostUsd` are per-call increments. For cumulative per-session totals, use `sessionTotalTurns` and `sessionTotalCostUsd`. When `forkSession=true`, the returned `sessionId` (and `sessionTotal*`) refer to the forked session; the original session totals are preserved.

## Error Codes

MCP server validation/policy errors are returned as `Error [CODE]: message` where `CODE` is one of:

- `INVALID_ARGUMENT` — invalid inputs (e.g. missing sessionId, empty cwd)
- `SESSION_NOT_FOUND` — session not found in memory (expired or server restarted)
- `SESSION_BUSY` — session currently running
- `PERMISSION_DENIED` — operation not allowed by server policy
- `PERMISSION_REQUEST_NOT_FOUND` — permission request ID not found (already finished or expired)
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
