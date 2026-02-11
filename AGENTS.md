# Repo Agent Instructions (claude-code-mcp)

This repository is a TypeScript (ESM) MCP server that wraps the Claude Agent SDK / Claude Code CLI. Package name: `@leo000001/claude-code-mcp`.

## Quick Commands

- Install deps: `npm install`
- Build: `npm run build` (tsup)
- Dev watch: `npm run dev`
- Start server: `npm start` (runs `node dist/index.js`)
- Typecheck: `npm run typecheck`
- Test: `npm test` (Vitest, single run)
- Test watch: `npm run test:watch`
- Lint: `npm run lint` (covers `src/` and `tests/`)
- Format: `npm run format` / `npm run format:check`
- Runtime: Node.js `>= 18`

## Git / PR Workflow

- Branch from the repo's default branch (commonly `main`; this repo may be `master` locally).
- Before committing/opening a PR, run: `npm run typecheck`, `npm run lint`, `npm test`, `npm run format:check`.
- Pre-commit hook (`.husky/pre-commit`) runs **all three** automatically:
  1. `npx lint-staged` — runs `prettier --write` + `eslint --fix` on staged `*.ts` files
  2. `npm run typecheck`
  3. `npm test`
- Keep commits focused; the pre-commit hook will block on any failure.

## Project Layout

```
src/
├── index.ts              # Entry point — stdio transport, graceful shutdown
├── server.ts             # MCP server — tool registration, zod schemas, createServer()
├── types.ts              # Shared types, const tuples, ErrorCode enum
├── tools/
│   ├── claude-code.ts          # claude_code tool (start session)
│   ├── claude-code-reply.ts    # claude_code_reply tool (continue session)
│   ├── claude-code-session.ts  # claude_code_session tool (list/get/cancel)
│   └── claude-code-configure.ts # claude_code_configure tool (runtime config)
├── session/
│   └── manager.ts        # SessionManager — in-memory session lifecycle
└── utils/
    └── windows.ts        # Git Bash detection, Windows error hints
tests/
├── server.test.ts
├── tools.test.ts
├── claude-code-configure.test.ts
├── claude-code-session.test.ts
├── session-manager.test.ts
└── windows.test.ts
mcp_demo/                     # Copy-paste MCP client config examples
```

## Key Dependencies

- **`@anthropic-ai/claude-agent-sdk`** — core SDK; provides `query()` for agent sessions. Bundles its own Claude Code CLI (`cli.js`), does not use the system `claude` binary.
- **`@modelcontextprotocol/sdk`** — MCP protocol implementation (`McpServer`, `StdioServerTransport`).
- **`zod` (v4)** — input validation for all tool schemas; schemas live in `src/server.ts`.

## Architecture

- **4 MCP tools**: `claude_code`, `claude_code_reply`, `claude_code_session`, `claude_code_configure` — all registered in `src/server.ts`.
- **Session lifecycle**: `running` → `idle` | `error` | `cancelled`. The `SessionManager` holds an in-memory `Map<id, SessionInfo>`. Conversation history is persisted to disk by the SDK (under `~/.claude/projects/`), not by this server. `cancelled` is a terminal state — cancelled sessions cannot be resumed.
- **Atomic state transitions**: `SessionManager.tryAcquire()` atomically moves a session from `idle`/`error` to `running` (used by `claude_code_reply`).
- **Session fork**: `claude_code_reply` supports `forkSession: true` — creates a branched copy of the session; the original remains unchanged.
- **Session cleanup**: periodic timer removes idle sessions after TTL (default 30 min) and force-aborts stuck running sessions (default 4 hr).
- **Logging**: use `console.error` — stdout is reserved for MCP stdio communication.
- **Tool response pattern**: tools return `{ content: [{ type: "text", text }], isError }` — never throw from the tool handler; catch and wrap errors.
- **Graceful shutdown**: `index.ts` registers SIGINT/SIGTERM handlers; `server.close` is patched to call `sessionManager.destroy()` (aborts all running sessions).
- **Default settings**: the server loads all local Claude settings by default (`settingSources: ["user", "project", "local"]`), including `CLAUDE.md`. Pass `settingSources: []` for SDK isolation mode.

## Types Pattern (`src/types.ts`)

- Shared constants use `as const` tuples (e.g. `PERMISSION_MODES`, `EFFORT_LEVELS`) so both Zod schemas and TypeScript types derive from the same source.
- `ErrorCode` is an enum used for structured error messages: `Error [CODE]: message`.
- Session info has three tiers: `SessionInfo` (internal, full), `PublicSessionInfo` (redacted), `SensitiveSessionInfo` (includes cwd/prompt but excludes secrets like `env`).

## Build Details

- **tsup** config (`tsup.config.ts`): single entry `src/index.ts`, ESM-only, target `node18`, sourcemaps enabled, no `.d.ts` output.
- **`__PKG_VERSION__`**: compile-time define injected from `package.json` version — used in `src/server.ts` for the MCP server version string.
- **CLI binary**: tsup adds `#!/usr/bin/env node` banner; `package.json` `bin` field maps `claude-code-mcp` → `dist/index.js`.
- **TypeScript**: `strict: true`, target `ES2022`, `moduleResolution: "bundler"`.

## Environment Variables

These are set on the MCP server process (not the child Claude Code process):

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_GIT_BASH_PATH` | auto-detect | Path to `bash.exe` on Windows |
| `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME` | `0` | Allow `claude_code_reply` to resume from on-disk transcripts |
| `CLAUDE_CODE_MCP_ALLOW_SENSITIVE_SESSION_DETAILS` | `0` | Allow `claude_code_session` to return sensitive fields |
| `CLAUDE_CODE_MCP_SESSION_TTL_MS` | `1800000` (30 min) | Idle session TTL |
| `CLAUDE_CODE_MCP_RUNNING_SESSION_MAX_MS` | `14400000` (4 hr) | Max running session duration |
| `CLAUDE_CODE_MCP_CLEANUP_INTERVAL_MS` | `60000` (1 min) | Cleanup timer interval |

## Code Style & Conventions

- **ESM + TS**: keep `"type": "module"` semantics.
- **Import paths**: local imports use `.js` extensions in TypeScript source (leave this pattern intact).
- **Types**: prefer `unknown` + narrowing over `any`; if `any` is unavoidable, keep it localized and justified by context.
- **ESLint**: flat config (`eslint.config.js`); `@typescript-eslint/no-explicit-any` is a warning; `@typescript-eslint/no-unused-vars` is an error (use `_`-prefixed args to intentionally ignore). Ignores: `dist/`, `node_modules/`, `*.config.*`.
- **Exports**: follow existing patterns (named exports; tools export an `*Input` type/interface and an `execute*` function).
- **Schemas**: tool inputs are validated with `zod`; keep validation close to tool registration in `src/server.ts`.
- **Errors**: use existing `ErrorCode` and the repo's `isError`/structured result patterns. Tool handlers catch all errors and return structured responses — never throw.
- **Formatting**: Prettier is the source of truth; don't hand-format against it. Key settings: double quotes (`singleQuote: false`), semicolons, trailing commas (ES5), `printWidth: 100`, `tabWidth: 2`.

## Build Artifacts

- Treat `dist/` as generated output. Prefer editing `src/` and running `npm run build` instead of hand-editing `dist/`.
- If you change runtime behavior/public API, update `README.md` accordingly. `DESIGN.md` is gitignored (local-only design notes, written in Chinese) — update it if present locally but don't expect it in git history.

## Security / Defaults

- Keep the "minimum tools, maximum capability" approach (don't add extra MCP tools unless necessary).
- `bypassPermissions` should remain disabled by default; only enable via explicit user action/config.
- Default `permissionMode` is `"dontAsk"` — auto-approves only tools in `allowedTools`, denies everything else without prompting.
- Sensitive session fields (cwd, systemPrompt, agents) are redacted by default; gated by `CLAUDE_CODE_MCP_ALLOW_SENSITIVE_SESSION_DETAILS`.
- Environment variables (`env` field) are never exposed in public session info. The `env` parameter merges as `{ ...process.env, ...input.env }` — user values take precedence.
- Gotcha: subagents require the `Task` tool in `allowedTools`; `mcpServers` tools need explicit `allowedTools` entries (e.g. `"mcp__server__*"`) in `dontAsk` mode.

## Testing Expectations

- Add/adjust Vitest tests in `tests/` for behavior changes, especially for tool argument validation, session behavior, and error handling.
- Test files follow `<module-name>.test.ts` naming convention.
- No separate `vitest.config` file — Vitest uses defaults from `package.json`.
- Keep tests deterministic and avoid network calls.
- Mock the `@anthropic-ai/claude-agent-sdk` `query()` function for tool tests (avoid real SDK calls).
- Mocking pattern: `vi.mock()` at module level → import → `vi.mocked()` for typed access. A `fakeStream()` async generator helper in `tools.test.ts` simulates SDK streaming responses.
- For time-dependent tests (TTL, timeout): use `vi.useFakeTimers()` / `vi.advanceTimersByTime()`, always wrapped in `try/finally` to restore real timers.
- Test structure: `describe/it` blocks, `beforeEach` creates fresh `SessionManager`, `afterEach` calls `manager.destroy()`.
- `tsconfig.json` only includes `src/` — Vitest handles test file type checking separately.

## Publishing

- `npm run prepublishOnly` triggers a build automatically.
- `publishConfig.access` is `"public"` (scoped package published publicly).
- `files` array limits the published package to: `dist/`, `LICENSE`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `README.md`, `SECURITY.md`, `CHANGELOG.md`.

## Shell Notes (Windows)

- When running PowerShell commands in automation, prefer `pwsh -NoProfile -Command "..."` to avoid user profile side effects/noise.
- The Claude Code CLI requires Git Bash on Windows. The `src/utils/windows.ts` module handles detection and provides user-facing error hints.

## CI/CD

- **CI** (`.github/workflows/ci.yml`): runs on push to `main`/`master`, `v*` tags, PRs, and `workflow_dispatch`. Node matrix: 18, 20, 22. Steps: `npm ci` → `typecheck` → `lint` → `format:check` → `test` → `build`.
- **Publish** (`.github/workflows/publish.yml`): triggered on `v*` tags. Uses Node 22, npm provenance, `--access public`. Requires `NPM_TOKEN` secret.
- **Dependabot** (`.github/dependabot.yml`): weekly updates for npm (10 PR limit) and github-actions (5 PR limit).
- **PR template**: includes checklist for typecheck, lint, test, format:check, docs.

## Changelog

- Update `CHANGELOG.md` for releases. Format: version headers with categorized sections (Features, Bug Fixes, Security, Documentation, Improvements).
