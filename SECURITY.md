# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in claude-code-mcp, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities
2. Report via [GitHub Security Advisories](https://github.com/xihuai18/claude-code-mcp/security/advisories/new)
3. Include a description of the vulnerability, steps to reproduce, and potential impact

We aim to acknowledge reports within 48 hours and provide a fix or mitigation plan within 7 days.

## Security Considerations

- This server uses an async permission flow: when a tool call needs approval, the session pauses (`waiting_permission`) and surfaces requests via `claude_code_check` (`actions[]`). Callers must explicitly approve/deny via `respond_permission`.
- The MCP server uses the Claude Agent SDK's bundled CLI (`cli.js`), not the system-installed `claude` binary
- Session metadata is held in-memory only and is not persisted to disk by the MCP server (the SDK's CLI persists conversation history separately)
- Disk resume is disabled by default (`CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=0`). If you set `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`, disk resume fallback also requires `CLAUDE_CODE_MCP_RESUME_SECRET` (default: unset) and a valid `resumeToken` from `claude_code`/`claude_code_reply`.
- `claude_code_session` redacts sensitive fields (cwd, systemPrompt, agents, additionalDirectories) by default; use `includeSensitive=true` to include them
- Sessions auto-expire after 30 minutes of inactivity
