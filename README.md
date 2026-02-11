# claude-code-mcp

MCP server that wraps [Claude Code (Claude Agent SDK)](https://docs.anthropic.com/en/docs/claude-code/overview) as tools, enabling any MCP client to invoke Claude Code for autonomous coding tasks.

Inspired by the [Codex MCP](https://developers.openai.com/codex/guides/agents-sdk/) design philosophy — minimum tools, maximum capability.

## Features

- **4 tools** covering the full agent lifecycle: start, continue, manage, configure
- **Session management** with resume and fork support
- **Fine-grained permissions** — tool whitelist/blacklist, permission modes
- **Custom subagents** — define specialized agents per session
- **Cost tracking** — per-session turn and cost accounting
- **Session cancellation** via AbortController
- **Auto-cleanup** — 30-minute idle timeout for expired sessions
- **Security** — `bypassPermissions` disabled by default

## Prerequisites

This MCP server uses the [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) package, which **bundles its own Claude Code CLI** (`cli.js`). It does not use the `claude` binary from your system PATH.

- The SDK's bundled CLI version is determined by the SDK package version (e.g. SDK 0.2.38 = Claude Code 2.1.38)
- **Configuration is shared** — the bundled CLI reads API keys and settings from `~/.claude/`, same as the system-installed `claude`
- You must have Claude Code configured (API key set up) before using this MCP server: see [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code/overview)

> **Note:** The bundled CLI version may differ from your system-installed `claude`. To check: `claude --version` (system) vs `npm ls @anthropic-ai/claude-agent-sdk` (SDK).

## Quick Start

### As an MCP server (recommended)

Add to your MCP client configuration (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "npx",
      "args": ["@leo000001/claude-code-mcp"]
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

Start a Claude Code agent that can read/write files, run commands, and more.

| Parameter                    | Type               | Required | Description                                                                                                                |
| ---------------------------- | ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `prompt`                     | string             | Yes      | Task or question for Claude Code                                                                                           |
| `cwd`                        | string             | No       | Working directory (defaults to server cwd)                                                                                 |
| `allowedTools`               | string[]           | No       | Auto-approved tools (skips permission prompts). In `"dontAsk"` mode this effectively acts as a whitelist                   |
| `disallowedTools`            | string[]           | No       | Tool blacklist                                                                                                             |
| `tools`                      | string[] \| object | No       | Base set of available tools (array of names, or `{ type: "preset", preset: "claude_code" }`)                               |
| `persistSession`             | boolean            | No       | Persist session history to disk (`~/.claude/projects/`). Default: `true`. Set `false` to disable.                          |
| `permissionMode`             | string             | No       | Defaults to `"dontAsk"`. Options: `"default"`, `"acceptEdits"`, `"bypassPermissions"`, `"plan"`, `"delegate"`, `"dontAsk"` |
| `maxTurns`                   | number             | No       | Maximum agentic turns                                                                                                      |
| `model`                      | string             | No       | Model to use (e.g. `"claude-sonnet-4-5-20250929"`)                                                                         |
| `systemPrompt`               | string \| object   | No       | Custom system prompt (string or `{ type: "preset", preset: "claude_code", append?: "..." }`)                               |
| `agents`                     | object             | No       | Custom subagent definitions                                                                                                |
| `maxBudgetUsd`               | number             | No       | Maximum budget in USD                                                                                                      |
| `timeout`                    | number             | No       | Timeout in milliseconds for this session                                                                                   |
| `effort`                     | string             | No       | Effort level: `"low"`, `"medium"`, `"high"`, `"max"`                                                                       |
| `betas`                      | string[]           | No       | Beta features (e.g. `["context-1m-2025-08-07"]`)                                                                           |
| `additionalDirectories`      | string[]           | No       | Additional directories the agent can access beyond cwd                                                                     |
| `outputFormat`               | object             | No       | Structured output: `{ type: "json_schema", schema: {...} }`. Omit for plain text                                           |
| `thinking`                   | object             | No       | Thinking mode: `{ type: "adaptive" }`, `{ type: "enabled", budgetTokens: N }`, or `{ type: "disabled" }`                   |
| `pathToClaudeCodeExecutable` | string             | No       | Path to a custom Claude Code executable                                                                                    |
| `agent`                      | string             | No       | Main-thread agent name to apply custom agent system prompt, tool restrictions, and model                                   |
| `mcpServers`                 | object             | No       | MCP server configurations (key: server name, value: server config)                                                         |
| `sandbox`                    | object             | No       | Sandbox settings for command execution isolation                                                                           |
| `fallbackModel`              | string             | No       | Fallback model if the primary model fails or is unavailable                                                                |
| `enableFileCheckpointing`    | boolean            | No       | Enable file checkpointing to track file changes during the session                                                         |
| `includePartialMessages`     | boolean            | No       | Include partial/streaming message events in output                                                                         |
| `strictMcpConfig`            | boolean            | No       | Enforce strict validation of MCP server configurations                                                                     |
| `settingSources`             | string[]           | No       | Control which filesystem settings are loaded (`"user"`, `"project"`, `"local"`)                                            |
| `debug`                      | boolean            | No       | Enable debug mode for verbose logging                                                                                      |
| `debugFile`                  | string             | No       | Write debug logs to a specific file path (implicitly enables debug mode)                                                   |
| `env`                        | object             | No       | Environment variables passed to the Claude Code process                                                                    |

**Returns:** `{ sessionId, result, isError, durationMs, durationApiMs?, numTurns, totalCostUsd, sessionTotalTurns?, sessionTotalCostUsd?, structuredOutput?, stopReason?, errorSubtype?, usage?, modelUsage?, permissionDenials? }`

### `claude_code_reply` — Continue a session

Continue an existing session with full context preserved.

| Parameter     | Type    | Required | Description                                   |
| ------------- | ------- | -------- | --------------------------------------------- |
| `sessionId`   | string  | Yes      | Session ID from a previous `claude_code` call |
| `prompt`      | string  | Yes      | Follow-up prompt                              |
| `forkSession` | boolean | No       | Fork to a new session (preserves original)    |
| `timeout`     | number  | No       | Timeout in milliseconds for this reply        |

<details>
<summary>Disk resume parameters (used when <code>CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1</code> and in-memory session is missing)</summary>

| Parameter                    | Type               | Description                          |
| ---------------------------- | ------------------ | ------------------------------------ |
| `cwd`                        | string             | Working directory                    |
| `allowedTools`               | string[]           | Auto-approved tools                  |
| `disallowedTools`            | string[]           | Tool blacklist                       |
| `tools`                      | string[] \| object | Base set of available tools          |
| `persistSession`             | boolean            | Persist session history to disk      |
| `permissionMode`             | string             | Permission mode                      |
| `maxTurns`                   | number             | Maximum agentic turns                |
| `model`                      | string             | Model to use                         |
| `systemPrompt`               | string \| object   | Custom system prompt                 |
| `agents`                     | object             | Custom subagent definitions          |
| `maxBudgetUsd`               | number             | Maximum budget in USD                |
| `effort`                     | string             | Effort level                         |
| `betas`                      | string[]           | Beta features                        |
| `additionalDirectories`      | string[]           | Additional directories               |
| `outputFormat`               | object             | Structured output format             |
| `thinking`                   | object             | Thinking mode                        |
| `resumeSessionAt`            | string             | Resume up to a specific message UUID |
| `pathToClaudeCodeExecutable` | string             | Path to Claude Code executable       |
| `agent`                      | string             | Main-thread agent name               |
| `mcpServers`                 | object             | MCP server configurations            |
| `sandbox`                    | object             | Sandbox settings                     |
| `fallbackModel`              | string             | Fallback model                       |
| `enableFileCheckpointing`    | boolean            | Enable file checkpointing            |
| `includePartialMessages`     | boolean            | Include partial message events       |
| `strictMcpConfig`            | boolean            | Strict MCP config validation         |
| `settingSources`             | string[]           | Filesystem settings sources          |
| `debug`                      | boolean            | Debug mode                           |
| `debugFile`                  | string             | Debug log file path                  |
| `env`                        | object             | Environment variables                |

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

**Returns:** `{ allowBypass, message }`

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

## Security

- **`permissionMode` defaults to `"dontAsk"`** — the agent will deny any operation not pre-approved, avoiding interactive prompts that would hang in MCP context.
- **`bypassPermissions` is disabled by default.** Use the `claude_code_configure` tool with action `enable_bypass` to enable it at runtime.
- Use `tools` / `disallowedTools` to restrict the base set of tools the agent can use. Use `allowedTools` to auto-approve tools without prompting.
- `maxTurns` and `maxBudgetUsd` prevent runaway execution.
- Sessions auto-expire after 30 minutes of inactivity.

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
