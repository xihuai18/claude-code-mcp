# Repo Agent Instructions (claude-code-mcp)

This repository is a TypeScript (ESM) MCP server wrapping Claude Agent SDK / Claude Code CLI.
Package: `@leo000001/claude-code-mcp`.
Assumption: MCP server and client run on the same machine (same platform), via stdio.

> Last Updated: 2026-02-27

## Document Boundary (Must Read)

This repo intentionally separates **execution rules** from **design details**:

| Topic                                                            | Primary Doc      |
| ---------------------------------------------------------------- | ---------------- |
| How to execute work, upgrade flow, required checks               | `AGENTS.md`      |
| Architecture internals, field/message mapping, lifecycle details | `docs/DESIGN.md` |
| End-user usage guide                                             | `README.md`      |
| Release history                                                  | `CHANGELOG.md`   |

Non-negotiable dedupe rule:

- Keep `AGENTS.md` action-oriented.
- Keep long parameter tables, message mapping, and protocol deep dives in `docs/DESIGN.md`.
- If details are needed, link to DESIGN anchors instead of duplicating.

## Design Snapshot (Summary Only)

Project direction:

- Use local Claude settings by default (`settingSources: ["user","project","local"]`)
- Expose only 4 MCP tools (`claude_code`, `claude_code_reply`, `claude_code_session`, `claude_code_check`)
- Keep startup non-blocking (start/reply return quickly; poll with check)
- Provide three-layer permission control (`advanced.tools` + allow/deny + async decision)

Detailed behavior, full field semantics, and lifecycle mapping:

- `docs/DESIGN.md#sdk-interface-baseline`
- `docs/DESIGN.md#upgrade-methodology`
- `docs/DESIGN.md` Section 4 (Options mapping matrix)
- `docs/DESIGN.md` Section 5 (SDK message mapping matrix)

## SDK Upgrade Runbook (Execution Playbook)

When dependency interfaces change (`@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, sometimes zod schema impacts), execute in this order:

1. Confirm authoritative type definitions:
   - `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
   - relevant MCP SDK type surface in `node_modules/@modelcontextprotocol/sdk`
2. Compare against design matrices in `docs/DESIGN.md` (Sections 4 and 5).
3. Apply code updates to required touch points:
   - `src/server.ts` (zod schema and tool contract)
   - `src/utils/build-options.ts` (Option field mapping/defaults)
   - `src/tools/query-consumer.ts` (message mapping/permission callback behavior)
   - `src/session/manager.ts` (session and permission lifecycle)
   - `src/types.ts` (shared types/const tuples)
4. Sync docs and release notes:
   - `README.md`
   - `docs/DESIGN.md`
   - `AGENTS.md`
   - `CHANGELOG.md`
5. Run full checks:
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
   - `npm run format:check`

## Full Maintenance & Dependency Update Workflow

This section is the authoritative end-to-end workflow for updating dependencies and keeping code + docs + tests aligned.

### 0) Goals and Constraints

- **Goal:** keep MCP tool contracts stable while staying current with the upstream SDKs.
- **Rule:** SDK type definitions are authoritative (`sdk.d.ts`), changelogs are hints.
- **Rule:** avoid duplicating long tables here; update detailed matrices only in `docs/DESIGN.md`.
- **Rule:** do not ship stale lockfiles when `package.json` uses `^` ranges (users will resolve newer versions).
- **Hygiene:** any temporary audit artifacts must be deleted before finishing.

### 1) Detect Updates (Local, Reproducible)

Run:

- `npm outdated` (top-level)
- `npm outdated --all` (transitive signal only; don't chase majors unless needed)

Record:

- current / wanted / latest for `@anthropic-ai/claude-agent-sdk` and `@modelcontextprotocol/sdk`
- whether `zod` stays compatible (SDK peers `zod@^4`)

### 2) Establish the Interface Baseline (Authoritative)

Always treat the installed type surface as the source of truth:

- Claude Agent SDK: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- MCP SDK: `node_modules/@modelcontextprotocol/sdk/dist/**` (only the surfaces we import)

If you need to compare two versions without changing the workspace yet:

1. Create a temporary directory under `tmp/` (example: `tmp/deps-audit/`).
2. Download tarballs via `npm pack` (example):
   - `npm pack @anthropic-ai/claude-agent-sdk@<old>`
   - `npm pack @anthropic-ai/claude-agent-sdk@<new>`
3. Extract and diff `package/sdk.d.ts`.
4. Delete `tmp/deps-audit/` after the report is done.

### 3) Impact Analysis Checklist (What Can Break)

For each upgraded runtime dependency:

- **Options surface:** compare SDK `Options` fields to `src/utils/build-options.ts` (`OptionSource` + copy logic).
- **Message surface:** compare SDK `SDKMessage` union (new `type`/`subtype`) to `src/tools/query-consumer.ts` mapping.
- **Tool discovery:** if `system/init.tools` adds new tool names, decide whether to add descriptions to `src/tools/tool-discovery.ts`.
- **Policy filters:** if new progress events appear, confirm `claude_code_check` filtering rules in `src/tools/claude-code-check.ts`.
- **Docs:** update `docs/DESIGN.md` matrices (Section 4 and 5) and ensure `README.md` matches behavior.

### 4) Apply Updates (Code + Docs + Tests)

#### 4.1 Update dependency ranges

- Edit `package.json` versions.

#### 4.2 Refresh the lockfile

- Run `npm install` to update `package-lock.json`.

#### 4.3 Close the code loop

- If SDK adds a new stream message subtype (e.g. `system/task_progress`), add mapping in `src/tools/query-consumer.ts`.
- If new progress events should be suppressed in minimal polling, update filtering logic in `src/tools/claude-code-check.ts`.

#### 4.4 Close the documentation loop

- Update `README.md` for user-visible behavior changes (polling semantics, event types, defaults).
- Update `docs/DESIGN.md` for detailed mapping truth.
- Update `NOTICE.md` direct dependency versions when they change.
- Update `CHANGELOG.md` under `Unreleased` with concise bullets.

#### 4.5 Close the test loop

- Add/adjust Vitest tests whenever:
  - a new SDK message is mapped/filtered
  - an Option mapping changes
  - a tool contract/schema changes

### 5) Verify (Definition of Done)

Run (in this order):

1. `npm run typecheck`
2. `npm run lint`
3. `npm test`
4. `npm run format:check`

Also verify:

- `docs/DESIGN.md#sdk-interface-baseline` + `docs/DESIGN.md#upgrade-methodology` still reflect reality.
- No new long mapping tables were added to `AGENTS.md`.
- `tmp/` contains no leftover audit artifacts.

## Documentation Update Pass (One Iteration)

After iterative doc refinement, complete one explicit update pass in the same branch:

1. Update `AGENTS.md` for process/policy changes only.
2. Update `docs/DESIGN.md` for technical detail/mapping changes only.
3. Update `CHANGELOG.md` under `Unreleased -> Documentation` with a concise entry.
4. Re-validate cross-links:
   - `docs/DESIGN.md#sdk-interface-baseline`
   - `docs/DESIGN.md#upgrade-methodology`
5. Verify no duplicated long tables drift back into `AGENTS.md`.

## Interface Alignment Rules

1. SDK type definitions are the final authority; changelog is secondary.
2. Fields directly mapped to SDK `Options` must keep SDK names.
3. Non-SDK policy/protocol fields keep project contract names.
4. No long-lived compatibility aliases by default; prefer one-shot rename migration.
5. Any interface change must close the full loop: schema + handlers + manager + mapping + tests + docs.

## Required Change-Closure Checklist

Before merge, ensure all applicable items are updated:

- `src/server.ts`
- `src/tools/*.ts` related handlers
- `src/session/manager.ts`
- `src/utils/build-options.ts`
- `src/tools/query-consumer.ts`
- `src/types.ts`
- `tests/*.test.ts` related suites
- `README.md`
- `docs/DESIGN.md`
- `AGENTS.md`
- `CHANGELOG.md`

If a changed SDK field or message type is not reflected in at least one test, treat as incomplete.

## Quick Commands

- Install deps: `npm install`
- Build: `npm run build`
- Dev watch: `npm run dev`
- Start server: `npm start`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- Test watch: `npm run test:watch`
- Lint: `npm run lint`
- Format: `npm run format`
- Format check: `npm run format:check`

## Git / PR Workflow

- Base branch: `master`
- Keep commits focused and non-interactive
- Before commit/PR, run:
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
  - `npm run format:check`

Pre-commit hook (`.husky/pre-commit`) runs:

1. `npx lint-staged` (`prettier --write` + `eslint --fix` for staged `*.ts`)
2. `npm run typecheck`
3. `npm test`

## Project Layout (Condensed)

```text
src/
  index.ts                entry + shutdown
  server.ts               MCP tools + zod schema
  types.ts                shared types/constants
  tools/
    claude-code.ts
    claude-code-reply.ts
    claude-code-session.ts
    claude-code-check.ts
    query-consumer.ts
    tool-discovery.ts
  session/
    manager.ts
  utils/
    build-options.ts
    race-with-abort.ts
    resume-token.ts
    windows.ts
    ...
tests/
docs/
mcp_demo/
```

## Key Dependencies

- `@anthropic-ai/claude-agent-sdk`
- `@modelcontextprotocol/sdk`
- `zod` (v4)

## Code Style & Conventions

- ESM + TS only (`"type": "module"`)
- Local TS imports keep `.js` extension style
- Prefer `unknown` + narrowing over `any`
- zod schemas stay near tool registration in `src/server.ts`
- Keep zod `.describe()` minimal and include default semantics:
  - `Default: <value>`
  - `Default: SDK`
  - `Default: none`
  - `Default: SDK-bundled` (for `pathToClaudeCodeExecutable`)

Formatting source of truth:

- Prettier (`singleQuote: false`, semicolons on, trailing commas ES5, `printWidth: 100`)

## Security / Defaults

- Keep minimum-tools philosophy (do not add extra MCP tools lightly)
- Default permission mode remains `default` with async permission callback path
- Sensitive session fields are redacted unless explicitly requested
- `advanced.env` merges as `{ ...process.env, ...input.advanced.env }`, user values take precedence
- Subagent usage requires `Task` tool permission (or explicit approval path)

## Environment Variables (Server Process)

- `CLAUDE_CODE_GIT_BASH_PATH`
- `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME`
- `CLAUDE_CODE_MCP_RESUME_SECRET`
- `CLAUDE_CODE_MCP_MAX_SESSIONS`
- `CLAUDE_CODE_MCP_MAX_PENDING_PERMISSIONS`
- `CLAUDE_CODE_MCP_EVENT_BUFFER_MAX_SIZE`
- `CLAUDE_CODE_MCP_EVENT_BUFFER_HARD_MAX_SIZE`

For defaults and semantics, reference `README.md` and `docs/DESIGN.md`.

## Testing Expectations

- Add/adjust Vitest tests for behavior changes
- Avoid real network calls
- Mock `@anthropic-ai/claude-agent-sdk` `query()` in tool tests
- Use fake timers for timeout/TTL tests (`vi.useFakeTimers()` + cleanup)

Minimum suites to touch when relevant:

- `tests/server.test.ts`
- `tests/tools.test.ts`
- `tests/build-options.test.ts`
- `tests/query-consumer.test.ts`
- `tests/session-manager.test.ts`
- `tests/claude-code-check.test.ts`
- `tests/claude-code-reply.test.ts`
- `tests/tool-discovery.test.ts`
- `tests/resources.test.ts`
- `tests/resume-token.test.ts`

## Build Artifacts / Publishing / CI

- Edit `src/`, not `dist/`
- `npm run prepublishOnly` triggers build
- Publish is public scoped package
- CI runs typecheck + lint + format:check + test + build (Node 18/20/22)

## Windows Notes

- Prefer automation commands as `pwsh -NoProfile -Command "..."`
- Claude Code CLI requires Git Bash on Windows
- Windows-specific detection and hints live in `src/utils/windows.ts`

## Maintenance Principle

If AGENTS and DESIGN diverge:

1. Fix DESIGN for detailed technical truth.
2. Keep AGENTS concise and executable.
3. Replace duplication with links to DESIGN anchors.
