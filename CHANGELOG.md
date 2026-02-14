# Changelog

## Unreleased

### Breaking Changes
- `claude_code` and `claude_code_reply` now start asynchronously and return `{ sessionId, status: "running", pollInterval }`. Use `claude_code_check` to poll events and fetch the final `result`.
- Removed tool: `claude_code_configure`
- New tool: `claude_code_check` (poll + respond_permission)
- **Parameter nesting refactor**: low-frequency parameters have been folded into nested objects to reduce top-level clutter. This is a breaking change for callers that pass these parameters at the top level:
  - `claude_code`: 22 low-frequency params moved into `advanced` object (e.g. `effort` → `advanced.effort`, `tools` → `advanced.tools`, `agents` → `advanced.agents`, `env` → `advanced.env`)
  - `claude_code_reply`: 28 disk-resume params moved into `diskResumeConfig` object (e.g. `resumeToken` → `diskResumeConfig.resumeToken`, `cwd` → `diskResumeConfig.cwd`)
  - `claude_code_check`: 9 poll control params moved into `pollOptions` object (e.g. `includeTools` → `pollOptions.includeTools`); 2 permission response params moved into `permissionOptions` object (e.g. `updatedInput` → `permissionOptions.updatedInput`)

### Features
- New module: `src/tools/query-consumer.ts` — shared background query consumer (`consumeQuery`) for start, resume, and disk-resume code paths
- New module: `src/tools/tool-discovery.ts` — runtime tool discovery with `TOOL_CATALOG`, `ToolDiscoveryCache`, and dynamic `claude_code` description generation
- New module: `src/utils/build-options.ts` — centralized SDK `Partial<Options>` construction from flat input objects
- New module: `src/utils/race-with-abort.ts` — race a promise against an AbortSignal with cleanup
- New module: `src/utils/resume-token.ts` — HMAC-SHA256 resume token generation/validation for secure disk resume

### Improvements
- `claude_code_check`: default `responseMode="minimal"` to reduce payload size; supports `maxEvents` pagination with `truncated`/`truncatedFields`
- `claude_code_check`: minimal mode now slims assistant message events (strips `usage`, `model`, `id`, `cache_control` from content blocks)
- `claude_code_check`: minimal mode filters out noisy progress events (`tool_progress`, `auth_status`); use `includeProgressEvents: true` to restore
- `claude_code_check`: minimal mode omits `lastEventId`/`lastToolUseId` from top-level response and `durationApiMs`/`sessionTotalTurns`/`sessionTotalCostUsd` from AgentResult
- `claude_code_check`: includes lightweight session diagnostics (`cancelledAt`/`cancelledReason`/`cancelledSource`, `lastEventId`, `lastToolUseId`)
- Disk resume security: disk resume fallback requires `CLAUDE_CODE_MCP_RESUME_SECRET` + `resumeToken`

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
