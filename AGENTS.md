# Repo Agent Instructions (claude-code-mcp)

This repository is a TypeScript (ESM) MCP server that wraps the Claude Agent SDK / Claude Code CLI. Package name: `@leo000001/claude-code-mcp`.

## Project Philosophy & Design Goals

本项目的核心设计理念可以概括为：**利用用户本地 Claude 配置，用最少工具和最少配置，实现最大的 Claude Code SDK 能力调用，同时保证完全无阻塞和完善的权限管理。**

### 1. 利用用户本地 Claude 配置（Zero-Config Local Integration）

与原始 SDK 默认的隔离模式不同，本 MCP server 默认加载用户本地的全部 Claude 配置：

- **`settingSources` 默认为 `["user", "project", "local"]`**（见 `src/types.ts` 的 `DEFAULT_SETTING_SOURCES`），自动读取：
  - `~/.claude/settings.json`（用户级设置）
  - `.claude/settings.json`（项目级设置，可提交到版本控制）
  - `.claude/settings.local.json`（本地设置，不提交）
  - `CLAUDE.md`（项目上下文文件）
- **API Key 共享**：SDK 内置的 CLI 从 `~/.claude/` 读取 API key，与系统安装的 `claude` 命令共享配置
- **环境变量继承**：`advanced.env` 参数以 `{ ...process.env, ...input.advanced.env }` 方式合并，用户值优先覆盖，无需重复配置
- **可选隔离**：传 `advanced.settingSources: []` 可切换为 SDK 隔离模式，不加载任何本地配置

这意味着用户在本地 Claude Code CLI 中的所有配置（权限规则、项目上下文、API key）都会被 MCP server 自动继承，实现真正的零配置启动。

### 2. 最少工具（Minimum Tools）

受 OpenAI Codex MCP 极简设计（仅 `codex` + `codex-reply`）启发，本项目仅暴露 **4 个 MCP 工具**，覆盖完整的 agent 生命周期：

| 工具                  | 职责                                 | 阻塞？               |
| --------------------- | ------------------------------------ | -------------------- |
| `claude_code`         | 启动新 session                       | 仅等 init（~几百ms） |
| `claude_code_reply`   | 继续已有 session（含 fork/磁盘恢复） | 立即返回             |
| `claude_code_session` | 管理 session（list/get/cancel）      | 同步                 |
| `claude_code_check`   | 轮询事件 + 处理权限请求              | 同步                 |

不暴露额外的配置工具（已移除 `claude_code_configure`）、不暴露内部工具代理、不暴露 resources/prompts。所有能力通过这 4 个工具的参数组合实现。

### 3. 最少配置（Minimum Configuration）

`claude_code` 仅 `prompt` 为必填参数，其余高频参数（`cwd`, `allowedTools`, `disallowedTools`, `maxTurns`, `model`, `systemPrompt`, `permissionRequestTimeoutMs`）保留在顶层，22 个低频参数折叠到 `advanced` 对象中：

- **工作目录**：默认为 server 进程的 cwd
- **权限**：默认 `permissionMode="default"` + 空 `allowedTools`/`disallowedTools`（所有工具调用都会触发权限请求）
- **会话持久化**：默认 `advanced.persistSession=true`（历史保存到 `~/.claude/projects/`）
- **超时**：`advanced.sessionInitTimeoutMs=10000`，`permissionRequestTimeoutMs=60000`
- **设置来源**：默认加载全部本地设置（见上方第 1 点）
- **模型/effort/thinking**：默认使用 SDK/Claude Code 的默认值

调用方只需 `{ prompt: "Fix the bug in auth.ts" }` 即可启动一个功能完整的 coding agent。

### 4. 最大 SDK 能力暴露（Maximum SDK Capability）

本项目将 Claude Agent SDK 的 `Options` 接口几乎完整地暴露为工具参数（通过 `src/utils/build-options.ts` 统一构建）。高频参数保留在顶层，低频参数折叠到嵌套对象中（`claude_code` 的 `advanced`、`claude_code_reply` 的 `diskResumeConfig`、`claude_code_check` 的 `pollOptions`/`permissionOptions`），包括：

- **模型控制**：`model`、`advanced.fallbackModel`、`advanced.effort`、`advanced.thinking`、`advanced.betas`
- **工具控制**：`advanced.tools`（可见性）、`allowedTools`/`disallowedTools`（审批策略）
- **系统提示**：`systemPrompt`（完全替换或 preset + append 扩展）
- **子 Agent**：`advanced.agents`（定义自定义子 agent，含 prompt/tools/model/mcpServers）
- **MCP 嵌套**：`advanced.mcpServers`（agent 内部可连接其他 MCP server）
- **沙箱**：`advanced.sandbox`（命令执行隔离，如 Docker 容器）
- **结构化输出**：`advanced.outputFormat`（JSON Schema 约束输出格式）
- **费用/轮次限制**：`advanced.maxBudgetUsd`、`maxTurns`
- **文件检查点**：`advanced.enableFileCheckpointing`
- **调试**：`advanced.debug`、`advanced.debugFile`
- **环境变量**：`advanced.env`（合并到子进程环境）
- **额外目录**：`advanced.additionalDirectories`

`claude_code_reply` 在磁盘恢复场景下通过 `diskResumeConfig` 对象支持全部参数，确保重启后能以相同配置恢复 session。

### 5. 完全无阻塞（Non-Blocking Async Execution）

传统 MCP 工具调用是同步阻塞的 — 调用方必须等待整个 agent 执行完毕才能收到响应。本项目通过异步架构彻底解决了这个问题：

**启动即返回**：`claude_code` 和 `claude_code_reply` 启动后台 consumer 后立即返回 `{ sessionId, status: "running", pollInterval }`，不阻塞调用方。

**后台消费**：`src/tools/query-consumer.ts` 的 `consumeQuery()` 在后台持续消费 SDK 的 `query()` AsyncIterable 流，将事件写入 `SessionManager` 的 `EventBuffer`。

**轮询获取**：调用方通过 `claude_code_check` 的 `action="poll"` 增量获取事件（cursor 分页），直到 status 变为 `idle`/`error`/`cancelled`。

**事件缓冲**：`EventBuffer` 使用简单数组 + pin 策略（关键事件如 permission_request/result/error 不被淘汰），默认 maxSize=1000，hardMaxSize=2000。

**AbortController 生命周期**：每个 session 持有独立的 `AbortController`，cancel 时 abort，完成后清理。`src/utils/race-with-abort.ts` 提供 Promise 与 AbortSignal 的竞争机制。

### 6. 完善的权限管理（Complete Permission Management）

本项目实现了三层权限防护 + 异步权限裁决流程：

**第零层 — 模型可见性控制（`advanced.tools` 参数）**：
- 控制 agent 能"看到"哪些工具。不在 `advanced.tools` 列表中的工具从模型上下文中完全消失
- 最强限制：工具不可见 = 不可能被调用

**第一层 — 输入侧硬限制（`allowedTools` / `disallowedTools`）**：
- `allowedTools`：自动批准，不触发权限请求
- `disallowedTools`：无条件拒绝，即使后续通过 `respond_permission` 批准也会被拦截
- 调用方根据 `claude_code` 工具描述中的内部工具清单（由 `tool-discovery.ts` 动态生成）自行判断

**第二层 — 异步权限裁决（`canUseTool` 回调）**：
- 不在 allow/deny 列表中的工具 → SDK 发 `can_use_tool` → MCP server 创建权限请求
- Session 状态转为 `waiting_permission`，请求通过 `claude_code_check` 的 `actions[]` 暴露给调用方
- 调用方通过 `respond_permission` 逐个批准/拒绝
- 支持高级操作：`permissionOptions.updatedInput`（修改工具输入后再执行）、`permissionOptions.updatedPermissions`（更新权限规则）、`interrupt`（deny 时中断整个 agent）、`denyMessage`（拒绝原因，展示给 Claude）

**权限请求生命周期**：
- 创建时启动超时计时器（`permissionRequestTimeoutMs`，默认 60s）
- 超时自动 deny（不中断 agent）
- Session cancel 时所有 pending 请求自动 deny + interrupt
- `finishRequest` 幂等机制确保每个请求只被处理一次（无论来源是 respond/timeout/cancel/signal/cleanup）
- 支持并发权限请求（子 agent 场景，通过 `agentID` 区分）

**运行时工具发现**：
- `tool-discovery.ts` 维护 `TOOL_CATALOG` 静态映射（工具名 → 描述 + 分类）
- 首个 session 的 `system/init` 消息提供运行时工具列表，与静态映射合并
- 合并结果用于动态生成 `claude_code` 的工具描述，并通过 `tools/list_changed` 通知支持 discovery 的 Client
- `claude_code_check` 的 `pollOptions.includeTools=true` 返回权威的 `availableTools` 列表

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

- Branch from the repo's default branch (`master`).
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
│   ├── claude-code-check.ts    # claude_code_check tool (poll + permission decisions)
│   ├── query-consumer.ts       # Shared background query consumer (consumeQuery)
│   └── tool-discovery.ts       # Runtime tool discovery, TOOL_CATALOG, dynamic description
├── session/
│   └── manager.ts        # SessionManager — in-memory session lifecycle, event buffer, permissions
└── utils/
    ├── build-options.ts  # Shared helper: build SDK Partial<Options> from flat source
    ├── race-with-abort.ts # Race a promise against an AbortSignal with cleanup
    ├── resume-token.ts   # HMAC-based resume token generation (CLAUDE_CODE_MCP_RESUME_SECRET)
    └── windows.ts        # Git Bash detection, Windows error hints
tests/
├── server.test.ts
├── tools.test.ts
├── claude-code-check.test.ts
├── claude-code-session.test.ts
├── query-consumer.test.ts
├── session-manager.test.ts
├── tool-discovery.test.ts
└── windows.test.ts
docs/                         # Design docs (Chinese), refactoring logs
mcp_demo/                     # Copy-paste MCP client config examples
```

## Key Dependencies

- **`@anthropic-ai/claude-agent-sdk`** — core SDK; provides `query()` for agent sessions. Bundles its own Claude Code CLI (`cli.js`), does not use the system `claude` binary.
- **`@modelcontextprotocol/sdk`** — MCP protocol implementation (`McpServer`, `StdioServerTransport`).
- **`zod` (v4)** — input validation for all tool schemas; schemas live in `src/server.ts`.

## Architecture

- **4 MCP tools**: `claude_code`, `claude_code_reply`, `claude_code_session`, `claude_code_check` — all registered in `src/server.ts`.
- **Async execution**: `claude_code` and `claude_code_reply` start asynchronously and return `{ sessionId, status: "running", pollInterval }`. Use `claude_code_check` to poll events and fetch the final result.
- **Query consumer** (`src/tools/query-consumer.ts`): shared background logic for consuming SDK `query()` streams. Both `claude_code` (start) and `claude_code_reply` (resume/disk-resume) delegate to `consumeQuery()`.
- **Tool discovery** (`src/tools/tool-discovery.ts`): maintains a `TOOL_CATALOG` of known Claude Code internal tools with descriptions and categories. Merges runtime `system/init` tool lists with the static catalog. Generates dynamic `claude_code` tool descriptions. `ToolDiscoveryCache` updates on first session init and triggers `tools/list_changed`.
- **Build options** (`src/utils/build-options.ts`): centralizes SDK `Partial<Options>` construction from flat input objects — used by start, reply, and disk-resume code paths.
- **Session lifecycle**: `running` ↔ `waiting_permission` → `idle` | `error` | `cancelled`. The `SessionManager` holds an in-memory `Map<id, SessionInfo>` plus an event buffer (polled via `claude_code_check`) and pending permission requests. Conversation history is persisted to disk by the SDK (under `~/.claude/projects/`), not by this server. `cancelled` is a terminal state — cancelled sessions cannot be resumed.
- **Async permissions**: when a tool call needs approval, the session transitions to `waiting_permission` and surfaces requests via `claude_code_check` (`actions[]`). Callers approve/deny via `respond_permission`. Three-layer defense: `advanced.tools` (visibility), `allowedTools`/`disallowedTools` (auto-approve/deny), `canUseTool` callback (interactive).
- **Resume token** (`src/utils/resume-token.ts`): HMAC-SHA256 token for secure disk resume. Only generated when `CLAUDE_CODE_MCP_RESUME_SECRET` is set.
- **Atomic state transitions**: `SessionManager.tryAcquire()` atomically moves a session from `idle`/`error` to `running` (used by `claude_code_reply`).
- **Session fork**: `claude_code_reply` supports `forkSession: true` — creates a branched copy of the session; the original remains unchanged.
- **Session cleanup**: periodic timer removes idle sessions after TTL (default 30 min) and force-aborts stuck running sessions (default 4 hr).
- **Logging**: use `console.error` — stdout is reserved for MCP stdio communication.
- **Tool response pattern**: tools return `{ content: [{ type: "text", text }], isError }` — never throw from the tool handler; catch and wrap errors.
- **Graceful shutdown**: `index.ts` registers SIGINT/SIGTERM handlers; `server.close` is patched to call `sessionManager.destroy()` (aborts all running sessions).
- **Default settings**: the server loads all local Claude settings by default (`advanced.settingSources: ["user", "project", "local"]`), including `CLAUDE.md`. Pass `advanced.settingSources: []` for SDK isolation mode.

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

| Variable                            | Default     | Purpose                                                             |
| ----------------------------------- | ----------- | ------------------------------------------------------------------- |
| `CLAUDE_CODE_GIT_BASH_PATH`         | auto-detect | Path to `bash.exe` on Windows                                       |
| `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME` | `0`         | Allow `claude_code_reply` to resume from on-disk transcripts        |
| `CLAUDE_CODE_MCP_RESUME_SECRET`     | *(unset)*   | HMAC secret used to validate `resumeToken` for disk resume fallback |

## Code Style & Conventions

- **ESM + TS**: keep `"type": "module"` semantics.
- **Import paths**: local imports use `.js` extensions in TypeScript source (leave this pattern intact).
- **Types**: prefer `unknown` + narrowing over `any`; if `any` is unavoidable, keep it localized and justified by context.
- **ESLint**: flat config (`eslint.config.js`); `@typescript-eslint/no-explicit-any` is a warning; `@typescript-eslint/no-unused-vars` is an error (use `_`-prefixed args to intentionally ignore). Ignores: `dist/`, `node_modules/`, `*.config.*`.
- **Exports**: follow existing patterns (named exports; tools export an `*Input` type/interface and an `execute*` function).
- **Schemas**: tool inputs are validated with `zod`; keep validation close to tool registration in `src/server.ts`.
- **Zod `.describe()` convention**: every parameter in `src/server.ts` Zod schemas **must** document its default value (e.g. `Default: false`, `Default: SDK`, `Default: none`). Additional description text is optional — only add it when the field name alone is ambiguous. Keep descriptions as concise as possible. Convention for default values:
  - `Default: <concrete value>` — for params with a known default (e.g. `Default: false`, `Default: 10000`, `Default: []`)
  - `Default: SDK` — for params whose default is managed by the Claude Agent SDK
  - `Default: none` — for truly optional params with no default
  - `Default: SDK-bundled` — specifically for `pathToClaudeCodeExecutable`
  - Required params (e.g. `prompt`, `sessionId`) do not need a default annotation
- **Two-tier description strategy**: Zod `.describe()` strings are serialized into JSON Schema and sent to calling models — keep them minimal (default value + brief hint only when field name is ambiguous). Human-facing documentation (`README.md`, `docs/DESIGN.md`) should provide full, detailed descriptions with examples and context. Do not duplicate README-level detail into `.describe()` strings.
- **Errors**: use existing `ErrorCode` and the repo's `isError`/structured result patterns. Tool handlers catch all errors and return structured responses — never throw.
- **Formatting**: Prettier is the source of truth; don't hand-format against it. Key settings: double quotes (`singleQuote: false`), semicolons, trailing commas (ES5), `printWidth: 100`, `tabWidth: 2`.

## Build Artifacts

- Treat `dist/` as generated output. Prefer editing `src/` and running `npm run build` instead of hand-editing `dist/`.
- If you change runtime behavior/public API, update `README.md` accordingly. Design docs live in `docs/` (Chinese): `DESIGN.md` (architecture/tool design) and `refactor-v2-async-permissions.md` (v2 async refactoring log). Root-level `DESIGN.md` is gitignored (legacy).

## Security / Defaults

- Keep the "minimum tools, maximum capability" approach (don't add extra MCP tools unless necessary).
- The server runs the SDK in `permissionMode="default"` and always provides `canUseTool`. Callers can pre-approve via `allowedTools`/`disallowedTools`, and handle other approvals via `claude_code_check`.
- Sensitive session fields (cwd, systemPrompt, agents) are redacted by default; use `includeSensitive=true` in `claude_code_session` to include them.
- Environment variables (`advanced.env` field) are never exposed in public session info. The `advanced.env` parameter merges as `{ ...process.env, ...input.advanced.env }` — user values take precedence.
- Gotcha: subagents require the `Task` tool (or an explicit approval via `claude_code_check` when permission is requested).

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

## MCP 协议规范参考

本项目基于 MCP (Model Context Protocol) 构建。以下是协议要点及主要 coding agent 对 MCP 的支持情况。

> 信息来源：[modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-03-26)、各工具官方文档。调研日期：2025-02。

### 协议基础（Protocol Revision: 2025-03-26）

MCP 基于 JSON-RPC 2.0，三种消息类型：
- **Request**（双向）：含 `id`，需要 Response
- **Response**：含 `id`（匹配 Request），`result` 或 `error`
- **Notification**（双向）：无 `id`，无需响应

架构模型：**Host**（LLM 应用）→ **Client**（Host 内的连接器）→ **Server**（提供上下文和能力的服务）。

传输方式：
- **stdio**：Client 以子进程方式启动 Server，通过 stdin/stdout 通信（本项目使用）
- **Streamable HTTP**（取代旧版 HTTP+SSE）：Server 作为独立 HTTP 服务，POST 发送消息，可选 SSE 流式响应

### 生命周期

1. Client 发 `initialize`（声明 capabilities + protocolVersion）
2. Server 响应（声明 capabilities + serverInfo）
3. Client 发 `notifications/initialized`
4. 正常操作
5. 关闭：stdio 关 stdin → SIGTERM → SIGKILL

### Server 能力声明

| 能力          | 说明                                      | 本项目使用 |
| ------------- | ----------------------------------------- | ---------- |
| `tools`       | 暴露可调用工具（`listChanged` 子字段）    | ✅          |
| `resources`   | 提供可读资源（`subscribe`/`listChanged`） | ❌          |
| `prompts`     | 提供提示词模板（`listChanged`）           | ❌          |
| `logging`     | 可发送 `notifications/message`            | 计划中     |
| `completions` | 参数自动补全                              | ❌          |

### Client 能力声明

| 能力          | 说明                                                              |
| ------------- | ----------------------------------------------------------------- |
| `roots`       | 可提供文件系统根目录（`file://` URI）                             |
| `sampling`    | 支持 Server 请求 LLM 采样（`sampling/createMessage`）             |
| `elicitation` | 支持 Server 向用户收集信息（`elicitation/create`，form/url 模式） |

### Server 原语

**Tools**（本项目核心）：
- `tools/list` → 发现工具（分页：`cursor`/`nextCursor`）
- `tools/call { name, arguments }` → 调用工具，返回 `{ content[], isError? }`
- `notifications/tools/list_changed` → 工具列表变更通知
- Tool 定义含 `name`、`description`、`inputSchema`（JSON Schema）、`annotations?`

**Tool Annotations**（提示性，不可用于安全决策）：
- `readOnlyHint`（默认 false）、`destructiveHint`（默认 true）、`idempotentHint`（默认 false）、`openWorldHint`（默认 true）

**Resources**：`resources/list`、`resources/read`、`resources/subscribe`、`notifications/resources/updated`
**Prompts**：`prompts/list`、`prompts/get`

### Client 原语

**Roots**：Server 发 `roots/list` 请求 Client → 返回 `file://` URI 列表
**Sampling**：Server 发 `sampling/createMessage` 请求 Client 的 LLM 做推理（含 human-in-the-loop）
**Elicitation**：Server 发 `elicitation/create` 向用户收集结构化数据（form）或敏感信息（url）

### 通知机制

**Server → Client**：

| 方法                               | 用途                                     | SDK API                                                                |
| ---------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `notifications/message`            | 日志/事件推送（`data` 接受任意 JSON）    | `mcpServer.sendLoggingMessage(params)` 或 `extra.sendNotification()`   |
| `notifications/progress`           | 进度更新（需 Client 传 `progressToken`） | `extra.sendNotification({ method: "notifications/progress", params })` |
| `notifications/tools/list_changed` | 工具列表变更                             | `mcpServer.sendToolListChanged()`                                      |
| `notifications/resources/updated`  | 订阅资源更新                             | `mcpServer.server.sendResourceUpdated(params)`                         |
| `notifications/cancelled`          | 取消请求                                 | —                                                                      |

**Client → Server**：`notifications/initialized`、`notifications/roots/list_changed`、`notifications/cancelled`、`notifications/progress`

### SDK API 关键接口（`@modelcontextprotocol/sdk`）

```typescript
// McpServer 高层 API
mcpServer.sendLoggingMessage(params, sessionId?): Promise<void>  // notifications/message
mcpServer.sendToolListChanged(): void                            // notifications/tools/list_changed

// Server 底层 API（通过 mcpServer.server 访问）
server.createMessage(params): Promise<CreateMessageResult>       // sampling/createMessage
server.elicitInput(params): Promise<ElicitResult>                // elicitation/create
server.sendLoggingMessage(params, sessionId?): Promise<void>
server.sendResourceUpdated(params): Promise<void>

// Tool handler 内的 extra 对象
extra.sendNotification(notification): Promise<void>  // 请求作用域内发通知
extra._meta?.progressToken                           // Client 传入的进度 token
extra.signal                                         // AbortSignal
extra.sessionId                                      // MCP session ID
```

---

## 主要 Coding Agent 的 MCP 支持对比

> 以下信息均来自各工具官方文档及 [modelcontextprotocol.io/clients](https://modelcontextprotocol.io/clients)。

### 功能支持总览

| 功能         | Claude Code | VS Code Copilot | Cursor | Codex CLI | OpenCode | Copilot Coding Agent |
| ------------ | :---------: | :-------------: | :----: | :-------: | :------: | :------------------: |
| Tools        |      ✅      |        ✅        |   ✅    |     ✅     |    ✅     |          ✅           |
| Resources    |      ✅      |        ✅        |   ❌    |     ✅     |    ✅     |          ❌           |
| Prompts      |      ✅      |        ✅        |   ✅    |     ❌     |    ✅     |          ❌           |
| Discovery    |      ✅      |        ✅        |   ❌    |     ❌     |    ❌     |          ❌           |
| Instructions |      ✅      |        ✅        |   ❌    |     ❌     |    ❌     |          ❌           |
| Sampling     |      ❌      |        ✅        |   ❌    |     ❌     |    ❌     |          ❌           |
| Roots        |      ✅      |        ✅        |   ✅    |     ❌     |    ❌     |          ❌           |
| Elicitation  |      ❌      |        ✅        |   ✅    |     ✅     |    ❌     |          ❌           |
| DCR (OAuth)  |      ✅      |        ✅        |   ✅    |     ❌     |    ❌     |          ✅           |
| Apps         |      ❌      |        ✅        |   ❌    |     ❌     |    ❌     |          ❌           |

### 传输方式支持

| 传输方式        | Claude Code | VS Code Copilot | Cursor | Codex CLI | OpenCode | Copilot Coding Agent |
| --------------- | :---------: | :-------------: | :----: | :-------: | :------: | :------------------: |
| stdio           |      ✅      |        ✅        |   ✅    |     ✅     |    ✅     |          ✅           |
| SSE（旧版）     |      ✅      |        ✅        |   ✅    |     ❌     |    ❌     |          ✅           |
| Streamable HTTP |      ✅      |        ✅        |   ✅    |     ✅     |    ✅     |          ✅           |

### 各工具详情

#### Claude Code（Anthropic CLI）

- **官方文档**：[code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp)
- **角色**：MCP Client + 可作为 MCP Server（`claude mcp serve`）
- **支持功能**：Resources, Prompts, Tools, Roots, Instructions, Discovery, DCR
- **配置方式**：
  - CLI：`claude mcp add --transport <stdio|http|sse> <name> [-- <command>]`
  - JSON：`claude mcp add-json <name> '<json>'`
  - 从 Claude Desktop 导入：`claude mcp add-from-claude-desktop`
- **配置作用域**：
  - `local`（默认）：仅当前用户 + 当前项目，存储在 `~/.claude.json`
  - `project`：团队共享，存储在项目根目录 `.mcp.json`（可提交到版本控制）
  - `user`：当前用户所有项目，存储在 `~/.claude.json`
- **企业管理**：支持 `managed-mcp.json` 集中管控 + allowlist/denylist 策略
- **特色**：Tool Search（工具过多时自动按需加载）、OAuth 2.0 认证、Plugin MCP servers

#### VS Code GitHub Copilot

- **官方文档**：[code.visualstudio.com/docs/copilot/customization/mcp-servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
- **角色**：MCP Client（通过 Agent Mode 使用 MCP 工具）
- **支持功能**：Resources, Prompts, Tools, Discovery, Sampling, Roots, Elicitation, Instructions, Apps, CIMD, DCR — 目前功能最全面的 MCP Client
- **配置方式**：
  - 工作区：`.vscode/mcp.json`（可提交到版本控制）
  - 用户级：通过 `MCP: Open User Configuration` 命令
  - Dev Containers：`devcontainer.json` 的 `customizations.vscode.mcp`
  - CLI：`code --add-mcp "{...}"`
  - 扩展市场：搜索 `@mcp` 浏览 MCP Server 画廊
- **自动发现**：可从 Claude Desktop 等应用自动发现 MCP 配置（`chat.mcp.discovery.enabled`）
- **企业管理**：通过 GitHub 策略和企业 AI 设置集中管控

#### Cursor IDE

- **官方文档**：[cursor.com/docs/context/mcp](https://cursor.com/docs/context/mcp)
- **角色**：MCP Client（在 Composer 中使用 MCP 工具）
- **支持功能**：Prompts, Tools, Roots, Elicitation, DCR
- **不支持**：Resources, Sampling, Discovery, Instructions
- **传输方式**：stdio, SSE, HTTP, Streamable HTTP
- **配置方式**：项目级配置文件，支持 `npx`/`uvx`/`docker` 命令和远程 URL

#### OpenAI Codex CLI

- **官方文档**：[developers.openai.com/codex/mcp](https://developers.openai.com/codex/mcp/)
- **角色**：MCP Client（终端 + VS Code 扩展）
- **支持功能**：Resources（list/read/templates）, Tools（list/call）, Elicitation（路由到 TUI 用户输入）
- **不支持**：Prompts, Sampling, Roots, Discovery
- **配置方式**：
  - CLI：`codex mcp add <name> [--env K=V] -- <command>`
  - 配置文件：`~/.codex/config.toml` 或项目级 `.codex/config.toml`
  - TUI 内查看：`/mcp`
- **stdio 配置项**：`command`（必填）、`args`、`env`、`env_vars`、`cwd`
- **HTTP 配置项**：`url`（必填）、`bearer_token_env_var`、`http_headers`
- **通用配置项**：`startup_timeout_sec`（默认 10）、`tool_timeout_sec`（默认 60）、`enabled`、`required`、`enabled_tools`/`disabled_tools`
- **认证**：Bearer Token + OAuth（`codex mcp login <server>`）

#### OpenCode（sst/opencode）

- **官方文档**：[opencode.ai/docs/mcp-servers](https://opencode.ai/docs/mcp-servers/)
- **源码**：[github.com/anomalyco/opencode](https://github.com/anomalyco/opencode)
- **角色**：MCP Client（终端 + 桌面应用 + IDE 扩展）
- **支持功能**：Resources（`@` 前缀引用）, Prompts（`/` 前缀作为斜杠命令）, Tools
- **不支持**：Sampling, Roots, Elicitation, Discovery
- **配置方式**：`opencode.json` 的 `mcp` 字段
  - Local Server：`"type": "local"`，需 `command` 数组
  - Remote Server：`"type": "remote"`，需 `url`，可选 `headers`
- **OAuth 支持**：自动 DCR（RFC 7591）、预注册凭据、或禁用
- **CLI 命令**：`opencode mcp auth|list|logout|debug <server>`

#### GitHub Copilot Coding Agent

- **官方文档**：[docs.github.com/.../extending-copilot-coding-agent-with-mcp](https://docs.github.com/en/copilot/how-tos/agents/copilot-coding-agent/extending-copilot-coding-agent-with-mcp)
- **角色**：MCP Client（在 GitHub 云端自主执行任务）
- **支持功能**：Tools, DCR
- **不支持**：Resources, Prompts, Sampling, Roots, Elicitation
- **配置方式**：仓库 Settings → Copilot → Coding agent，JSON 格式 `mcpServers` 对象
- **特点**：
  - 内置 GitHub MCP Server（只读访问当前仓库）
  - 需通过 `tools` 数组显式允许工具
  - 环境变量/密钥需 `COPILOT_MCP_` 前缀
  - 不支持 OAuth 认证的远程 MCP Server
- **注意**：GitHub Copilot CLI（`gh copilot`）目前不支持 MCP

### 对本项目的启示

作为 MCP Server，本项目需要关注各 Client 的功能支持差异：
- **Tools** 是所有 Client 都支持的核心功能，本项目的 4 个工具可被所有上述 Client 使用
- **Resources/Prompts** 支持不一致（Cursor 不支持 Resources，Codex 不支持 Prompts），如果未来添加这些功能需注意兼容性
- **传输方式**：本项目使用 stdio，所有 Client 均支持；如需支持远程访问，Streamable HTTP 是最佳选择（所有 Client 均支持）
- **Discovery（list_changed）**：仅 Claude Code 和 VS Code Copilot 支持，动态工具更新在其他 Client 上不生效
