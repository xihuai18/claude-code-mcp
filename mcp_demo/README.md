# mcp_demo

This folder contains small, copy/paste-friendly examples for integrating this MCP server into common clients.

## Claude Desktop / Cursor (JSON config)

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

## OpenAI Codex CLI

```bash
codex mcp add claude-code -- npx -y @leo000001/claude-code-mcp
```

## Polling + permissions (v2 async)

`claude_code` / `claude_code_reply` start sessions asynchronously and return `{ sessionId, status: "running" }`.

To read progress, fetch the final result, and handle permission requests, call `claude_code_check`:

```json
{ "action": "poll", "sessionId": "<sessionId>" }
```

Store `nextCursor` from the response and pass it back on the next poll to avoid replaying old events:

```json
{ "action": "poll", "sessionId": "<sessionId>", "cursor": 123 }
```

Replace `123` with the `nextCursor` value from the previous response.

By default, `claude_code_check` uses `responseMode="minimal"` (smaller payloads) and paginates with `maxEvents=200`. If you need more detail (usage/modelUsage/structuredOutput), set `responseMode="full"`.

If `status` becomes `waiting_permission`, approve/deny each entry in `actions[]`:

```json
{
  "action": "respond_permission",
  "sessionId": "<sessionId>",
  "requestId": "<requestId>",
  "decision": "allow"
}
```

## Windows: Git Bash path

If you see the error about missing `git-bash`, set `CLAUDE_CODE_GIT_BASH_PATH`:

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
