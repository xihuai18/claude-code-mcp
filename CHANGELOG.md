# Changelog

## Unreleased

### Improvements

- Upgrade `@anthropic-ai/claude-agent-sdk` to `^0.2.81` and align exposed option passthrough with current SDK fields (`toolConfig`, `agentProgressSummaries`, `settings`).
- Expand SDK stream/event mapping for `rate_limit_event`, `system/api_retry`, `system/local_command_output`, `system/elicitation_complete`, `system/compact_boundary`, and partial `stream_event` output.
- Preserve newer SDK metadata in session/results, including `fastModeState` and richer permission prompt labels (`title`, `displayName`).
- Prefer SDK permission `suggestions` for `allow_for_session` responses and sync session metadata from `system/init` (for example actual model / permission mode).

### Documentation

- Add OpenCode-specific setup and usage guidance, including local MCP config examples and async polling recommendations.
- Sync README and DESIGN option/message matrices with the current SDK 0.2.81 surface.
- Add usage reminders in model-visible guidance: long Claude Code runs are normal, and follow-up questions should use `claude_code_reply` with the existing session.
- Separate agent-visible MCP guidance from repo-only documentation, and move more protocol-critical rules into tool descriptions and resources.

### Tests

- Add a reusable stdio metadata smoke script to verify agent-visible tool/resource guidance through a real MCP client transport.

## 2.5.0 (2026-02-27)

### Security

- Validate `resumeToken` using timing-safe comparison (`timingSafeEqual` for fixed-length HMAC tokens) to reduce timing side-channel risk.
- Refresh transitive dependencies via `npm audit fix` (0 known vulnerabilities after update).

### Improvements

- Upgrade `@anthropic-ai/claude-agent-sdk` to `^0.2.62` and align MCP-facing schemas with the current SDK surface.
- Upgrade `@modelcontextprotocol/sdk` to `^1.27.1`.
- Permission mode enum now follows SDK 0.2.62 (`default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`; `delegate` removed).
- Session cleanup now marks timed-out running/waiting sessions as `cancelled` for consistent status semantics.
- `SessionManager.destroy()` now clears in-memory session/runtime maps after aborting active runs, so post-destroy reads are no longer stale.
- Event buffer eviction now uses batch compaction (instead of repeated `findIndex` + `splice`) and `readEvents` now uses binary search for cursor start.
- Add configurable event-buffer limits via `CLAUDE_CODE_MCP_EVENT_BUFFER_MAX_SIZE` and `CLAUDE_CODE_MCP_EVENT_BUFFER_HARD_MAX_SIZE`.
- Runtime tool-discovery updates now notify both tools and resources (internal-tools resource change notification).
- Enrich compatibility resources with package version, disk-resume diagnostics, and runtime limits.
- Remove deprecated `claude_code` parameter aliases: top-level `sessionInitTimeoutMs` and `advanced.effort` / `advanced.thinking`.
- Add support for SDK `promptSuggestions` option passthrough and expose `promptSuggestions` in `advanced`/`diskResumeConfig`.
- Query consumer now maps additional SDK stream messages (`system/task_started`, `system/task_progress`, `system/hook_*`, `system/files_persisted`, `rate_limit`, `prompt_suggestion`) to progress events.
- Event buffer eviction now prefers dropping noisy progress events before output events to reduce missed output under high-frequency streams.

### Documentation

- Restructure documentation architecture: `AGENTS.md` is now execution-first, while `docs/DESIGN.md` is the single detailed source for interface/mapping semantics.
- Add explicit doc-governance rules, upgrade submission template, and document DoD to reduce AGENTS/DESIGN duplication regression.
- Align README/DESIGN/AGENTS with current defaults and behavior (timeout clamp, advanced parameter count, lifecycle semantics).
- Clarify package positioning as CLI-first and remove stale guidance that implied a public programmatic API surface.
- Update CONTRIBUTING with local environment requirements (Node/npm and Windows Git Bash notes).

### Tests

- Add dedicated tests for `resume-token` and `claude-code-reply`.
- Extend tests for event-buffer behavior, resource metadata, and runtime resource notifications.

## 2.2.0 (2026-02-17)

### Improvements

- Add `CLAUDE_CODE_MCP_MAX_SESSIONS` (default: `128`) to cap in-memory session count and reduce risk of memory exhaustion.
- Add `CLAUDE_CODE_MCP_MAX_PENDING_PERMISSIONS` (default: `64`) to cap outstanding permission requests per session.
- Promote `effort` and `thinking` to top-level parameters on `claude_code` and `claude_code_reply` (deprecated aliases: `advanced.effort`, `advanced.thinking`).
- Tool responses now include `structuredContent` (in addition to JSON text) for easier MCP client consumption.
- Emit `notifications/tools/list_changed` and `notifications/resources/list_changed` once after connect; update `claude_code` tool description dynamically when runtime tool discovery changes.
- Align declared MCP capabilities with implemented primitives (`logging`, `tools`, `resources`) and remove prompt primitive exposure.
- Add unit tests for `build-options.ts` and `race-with-abort.ts`.

### Bug Fixes

- Fork resume: restore original session state before creating the forked session record to avoid a brief `AbortController` sharing window.
- Session totals: prevent `totalTurns`/`totalCostUsd` from being overwritten when SDK-provided session totals look incremental.
- Permission audit: include allow-side `updatedInput`/`updatedPermissions` in `permission_result` events.

### Refactors

- Extract shared Zod schema fields for `advanced` and `diskResumeConfig` in `src/server.ts`.
- Deduplicate `SessionManager.create()` call payloads via a shared helper.
- Remove `server.close` monkey-patch; perform `sessionManager.destroy()` in the shutdown flow.

### Documentation

- Changelog: move released 2.x items out of `Unreleased` and add missing 2.0.0–2.0.3 entries.
- SECURITY: update supported versions table for 2.x.
- Docs: clarify same-platform assumption (MCP server and client run on the same machine) across README, AGENTS, SECURITY, and mcp_demo.

## 2.0.3 (2026-02-15)

### Improvements

- Version bump only.

## 2.0.2 (2026-02-15)

### Features

- MCP resources: `server-info`, `internal-tools`, and `gotchas`
- Permission workflow: include timeout/expiration metadata in permission actions; support `updatedInput` normalization

### Bug Fixes

- Windows: normalize MSYS-style paths for `NotebookEdit` where possible

## 2.0.1 (2026-02-15)

### Improvements

- Refined server schema descriptions/default annotations to reduce token overhead for calling models

## 2.0.0 (2026-02-15)

### Breaking Changes

- `claude_code` and `claude_code_reply` now start asynchronously and return `{ sessionId, status: "running", pollInterval }`. Use `claude_code_check` to poll events and fetch the final `result`.
- Removed tool: `claude_code_configure`
- New tool: `claude_code_check` (poll + respond_permission)
- Legacy `bypassPermissions` mode is no longer exposed in MCP schemas for 2.x.
- **Parameter nesting refactor**: low-frequency parameters have been folded into nested objects to reduce top-level clutter. This is a breaking change for callers that pass these parameters at the top level:
  - `claude_code`: 22 low-frequency params moved into `advanced` object in 2.0.0 (including `advanced.effort` / `advanced.thinking`, later removed)
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
- Permission result events now include `toolName`, and denial details (`message`, `interrupt`) when applicable
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
