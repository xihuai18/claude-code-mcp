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
