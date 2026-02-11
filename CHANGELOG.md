# Changelog

## 1.6.0 (2026-02-12)

### Bug Fixes
- Windows: fixed Git Bash auto-detection path derivation and improved candidate search

### Security
- `claude_code_session includeSensitive=true` no longer leaks extra fields (e.g. `env`, `debugFile`, `mcpServers`, `sandbox`) beyond the documented sensitive set

### Documentation
- README: clarify `Task` is required for subagent invocation and how `allowedTools` interacts with `mcpServers`
- README: clarify `includePartialMessages` is not streamed over MCP responses

## 1.4.0 (2026-02-11)

### Features
- New tool: `claude_code_configure` for runtime bypass mode management (enable/disable without restart)
- New parameters for `claude_code`: `additionalDirectories`, `outputFormat`, `thinking`, `tools`, `timeout`
- New parameters for `claude_code` and `claude_code_reply`: `pathToClaudeCodeExecutable`, `agent`, `mcpServers`, `sandbox`, `fallbackModel`, `enableFileCheckpointing`, `includePartialMessages`, `strictMcpConfig`, `settingSources`, `debug`, `debugFile`, `env`
- Effort level now supports `"max"` in addition to low/medium/high
- `AgentResult` now includes `structuredOutput`, `stopReason`, `errorSubtype`, `usage`, `modelUsage`, `permissionDenials`

### Improvements
- README: Added Prerequisites section clarifying Claude Code CLI dependency
- README/DESIGN.md: Updated parameter tables to include all supported parameters
- DESIGN.md: Updated to reflect 4-tool architecture and current security model
- SECURITY.md: Fixed inaccurate references to system CLI and env vars
- Moved `clearTimeout` into `finally` blocks for safer resource cleanup
- Added `break` after result processing in `claude_code_reply` for consistency

### Bug Fixes
- Fixed `claude_code_reply` not passing `cwd`/`permissionMode`/`allowDangerouslySkipPermissions` to SDK
- Fixed falsy filtering dropping valid values like empty arrays and zero
- Removed unsafe `as any` type assertions where possible
- Fixed fork overwriting original session status (now restores pre-fork status)
- Fixed `cancel()` allowing cancellation of non-running sessions
- Fixed `destroy()` clearing session map while in-flight operations still reference sessions
- Improved abort detection using SDK's `AbortError` class
- Added session overwrite guard in `create()`
- Added `lastActiveAt` update when aborting stuck sessions in cleanup

## 1.0.0 (2026-02-11)

### Features
- Initial release
- 3 MCP tools: `claude_code`, `claude_code_reply`, `claude_code_session`
- Session management with resume and fork support
- Fine-grained permission control (default, acceptEdits, bypassPermissions, plan, delegate, dontAsk)
- Custom subagent definitions
- Effort level control (low, medium, high)
- Beta features support (e.g., 1M context window)
- Cost and turn tracking per session
- Session cancellation via AbortController
- Auto-cleanup for idle (30min) and stuck running (4h) sessions
- Security: bypassPermissions disabled by default
