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

- `bypassPermissions` mode is disabled by default and requires explicit opt-in via the `claude_code_configure` tool at runtime
- The MCP server uses the Claude Agent SDK's bundled CLI (`cli.js`), not the system-installed `claude` binary
- Session metadata is held in-memory only and is not persisted to disk by the MCP server (the SDK's CLI persists conversation history separately)
- Disk resume is disabled by default. If you set `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`, the server may resume sessions from the CLI's on-disk transcript even if in-memory metadata is missing.
- `claude_code_session` redacts sensitive fields by default; `includeSensitive` requires `CLAUDE_CODE_MCP_ALLOW_SENSITIVE_SESSION_DETAILS=1`
- Sessions auto-expire after 30 minutes of inactivity
