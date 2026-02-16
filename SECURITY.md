# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 2.x     | Yes       |
| 1.x     | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in claude-code-mcp, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities
2. Report via [GitHub Security Advisories](https://github.com/xihuai18/claude-code-mcp/security/advisories/new)
3. Include a description of the vulnerability, steps to reproduce, and potential impact

We aim to acknowledge reports within 48 hours and provide a fix or mitigation plan within 7 days.

## Security Considerations

- This MCP server is designed for local use only — the server and client must run on the same machine. It communicates via stdio (child process), reads local configuration from `~/.claude/`, and accesses the local file system directly. Remote deployment is not supported.
- This server uses an async permission flow: when a tool call needs approval, the session pauses (`waiting_permission`) and surfaces requests via `claude_code_check` (`actions[]`). Callers must explicitly approve/deny via `respond_permission`.
- The MCP server uses the Claude Agent SDK's bundled CLI (`cli.js`), not the system-installed `claude` binary
- Session metadata is held in-memory only and is not persisted to disk by the MCP server (the SDK's CLI persists conversation history separately)
- To reduce memory exhaustion risk, the server caps in-memory session count via `CLAUDE_CODE_MCP_MAX_SESSIONS` (default: `128`).
- Disk resume is disabled by default (`CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=0`). If you set `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`, disk resume fallback also requires `CLAUDE_CODE_MCP_RESUME_SECRET` (default: unset) and a valid `resumeToken` from `claude_code`/`claude_code_reply`.
- `claude_code_session` redacts sensitive fields (cwd, systemPrompt, agents, additionalDirectories) by default; use `includeSensitive=true` to include them
- Sessions auto-expire after 30 minutes of inactivity
