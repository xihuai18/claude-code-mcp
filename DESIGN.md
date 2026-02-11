# Claude Code MCP Server - 设计文档

## 1. 概述

本项目实现一个 MCP (Model Context Protocol) Server，将 Claude Code (Claude Agent SDK) 的能力暴露为 MCP 工具，使任何 MCP 客户端（如 Claude Desktop、Cursor、其他 AI Agent）能够调用 Claude Code 进行自主编程。

### 设计哲学

参考 OpenAI Codex MCP 的极简设计（仅 `codex` + `codex-reply` 两个工具），本项目采用 **最少工具、最大能力** 的原则：

- **工具数量精简**：仅暴露 4 个工具，覆盖完整生命周期
- **会话状态管理**：通过 sessionId 维护多轮对话上下文
- **配置灵活**：支持权限、模型、工具集、effort 等细粒度控制
- **可审计**：所有操作可追踪

## 2. 工具设计

### Tool 1: `claude_code` — 启动新会话

启动一个新的 Claude Code Agent 会话，执行编程任务。

| 参数              | 类型     | 必需 | 说明                                                        |
| ----------------- | -------- | ---- | ----------------------------------------------------------- |
| `prompt`          | string   | 是   | 用户提示/任务描述                                           |
| `cwd`             | string   | 否   | 工作目录，默认为服务器进程目录                              |
| `allowedTools`    | string[] | 否   | 自动批准工具列表（跳过权限提示）；在 `permissionMode="dontAsk"` 下这基本等价于“允许工具清单” |
| `disallowedTools` | string[] | 否   | 工具黑名单（从可用工具集中剔除）                            |
| `tools`           | string[] / object | 否 | 可用工具集 (工具名数组或 preset)                            |
| `persistSession`  | boolean  | 否   | 是否将会话历史持久化到磁盘（`~/.claude/projects/`，默认 true；设为 false 可禁用） |
| `permissionMode`  | string   | 否   | default/acceptEdits/bypassPermissions/plan/delegate/dontAsk（默认：dontAsk） |
| `maxTurns`        | number   | 否   | 最大对话轮次                                                |
| `model`           | string   | 否   | 模型选择                                                    |
| `systemPrompt`    | string / object | 否 | 自定义系统提示 (字符串或 preset 对象)                       |
| `agents`          | object   | 否   | 子 Agent 定义                                               |
| `maxBudgetUsd`    | number   | 否   | 最大费用限制 (USD)                                          |
| `timeout`         | number   | 否   | 会话超时时间 (毫秒)                                        |
| `effort`          | string   | 否   | 努力程度: low/medium/high/max                               |
| `betas`           | string[] | 否   | Beta 功能 (如 1M 上下文)                                    |
| `additionalDirectories` | string[] | 否 | 额外可访问目录                                          |
| `outputFormat`    | object   | 否   | 输出格式: `{ type: "json_schema", schema: {...} }`          |
| `thinking`        | object   | 否   | 思考模式: adaptive/enabled(含 budgetTokens)/disabled        |
| `pathToClaudeCodeExecutable` | string | 否 | Claude Code 可执行文件路径                                  |
| `agent`           | string   | 否   | 主线程 agent 名称（应用自定义 agent 系统提示、工具限制和模型） |
| `mcpServers`      | object   | 否   | MCP 服务器配置（key: 服务器名, value: 服务器配置）          |
| `sandbox`         | object   | 否   | 沙箱设置（命令执行隔离）                                    |
| `fallbackModel`   | string   | 否   | 备用模型（主模型不可用时使用）                              |
| `enableFileCheckpointing` | boolean | 否 | 启用文件检查点（跟踪文件变更）                              |
| `includePartialMessages` | boolean | 否 | 包含部分/流式消息事件                                       |
| `strictMcpConfig` | boolean  | 否   | 严格验证 MCP 服务器配置                                     |
| `settingSources`  | string[] | 否   | 控制加载哪些文件系统设置 ("user"/"project"/"local")         |
| `debug`           | boolean  | 否   | 启用调试模式                                                |
| `debugFile`       | string   | 否   | 调试日志文件路径（隐式启用调试模式）                        |
| `env`             | object   | 否   | 传递给 Claude Code 进程的环境变量                           |

**返回值**：`{ sessionId, result, isError, durationMs, durationApiMs?, numTurns, totalCostUsd, sessionTotalTurns?, sessionTotalCostUsd?, structuredOutput?, stopReason?, errorSubtype?, usage?, modelUsage?, permissionDenials? }`

### Tool 2: `claude_code_reply` — 继续已有会话

| 参数          | 类型    | 必需 | 说明               |
| ------------- | ------- | ---- | ------------------ |
| `sessionId`   | string  | 是   | 要继续的会话 ID    |
| `prompt`      | string  | 是   | 后续提示           |
| `forkSession` | boolean | 否   | 是否 fork 到新会话 |
| `timeout`     | number  | 否   | 本次 reply 超时 (毫秒) |

<details>
<summary>磁盘恢复参数（当 <code>CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1</code> 且内存中 session 缺失时使用）</summary>

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `cwd` | string | 工作目录 |
| `allowedTools` | string[] | 自动批准工具列表 |
| `disallowedTools` | string[] | 工具黑名单 |
| `tools` | string[] / object | 可用工具集 |
| `persistSession` | boolean | 是否持久化会话历史 |
| `permissionMode` | string | 权限模式 |
| `maxTurns` | number | 最大对话轮次 |
| `model` | string | 模型选择 |
| `systemPrompt` | string / object | 自定义系统提示 |
| `agents` | object | 子 Agent 定义 |
| `maxBudgetUsd` | number | 最大费用限制 (USD) |
| `effort` | string | 努力程度 |
| `betas` | string[] | Beta 功能 |
| `additionalDirectories` | string[] | 额外可访问目录 |
| `outputFormat` | object | 输出格式 |
| `thinking` | object | 思考模式 |
| `resumeSessionAt` | string | 恢复到指定消息 UUID |
| `pathToClaudeCodeExecutable` | string | Claude Code 可执行文件路径 |
| `agent` | string | 主线程 agent 名称 |
| `mcpServers` | object | MCP 服务器配置 |
| `sandbox` | object | 沙箱设置 |
| `fallbackModel` | string | 备用模型 |
| `enableFileCheckpointing` | boolean | 启用文件检查点 |
| `includePartialMessages` | boolean | 包含部分/流式消息事件 |
| `strictMcpConfig` | boolean | 严格验证 MCP 服务器配置 |
| `settingSources` | string[] | 文件系统设置来源 |
| `debug` | boolean | 调试模式 |
| `debugFile` | string | 调试日志文件路径 |
| `env` | object | 环境变量 |

</details>

**返回值**：`{ sessionId, result, isError, durationMs, durationApiMs?, numTurns, totalCostUsd, sessionTotalTurns?, sessionTotalCostUsd?, structuredOutput?, stopReason?, errorSubtype?, usage?, modelUsage?, permissionDenials? }`

> 可选增强：当设置 `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1` 时，如果内存中的 session 元数据丢失（重启/TTL 清理），`claude_code_reply` 会尝试使用 Claude Code CLI 的磁盘 transcript 进行恢复；此时可额外传入上方折叠表中列出的会话选项以控制恢复行为。

### Tool 3: `claude_code_session` — 会话管理

| 参数               | 类型    | 必需          | 说明            |
| ------------------ | ------- | ------------- | --------------- |
| `action`           | string  | 是            | list/get/cancel |
| `sessionId`        | string  | get/cancel 时 | 目标会话 ID     |
| `includeSensitive` | boolean | 否            | 是否包含敏感字段（cwd/systemPrompt/agents/additionalDirectories，默认 false；需设置 `CLAUDE_CODE_MCP_ALLOW_SENSITIVE_SESSION_DETAILS=1`） |

**返回值**：`{ sessions, message?, isError? }`（默认会对敏感字段做脱敏；`includeSensitive=true` 时返回完整字段）

### Tool 4: `claude_code_configure` — 运行时配置

| 参数     | 类型   | 必需 | 说明                                              |
| -------- | ------ | ---- | ------------------------------------------------- |
| `action` | string | 是   | enable_bypass / disable_bypass / get_config       |

**返回值**：`{ allowBypass, message, isError? }`

运行时动态启用/禁用 `bypassPermissions` 模式，无需重启服务器或设置环境变量。

## 3. 架构

```
MCP Client ←→ (stdio/JSON-RPC) ←→ MCP Server
                                      ├── Session Manager
                                      │   ├── 会话状态跟踪 (Map<id, SessionInfo>)
                                      │   ├── 空闲超时清理 (30 分钟)
                                      │   └── 卡死会话清理 (4 小时)
                                      └── Claude Agent SDK (query())
```

## 4. 技术栈

| 组件      | 技术选型                         |
| --------- | -------------------------------- |
| 语言      | TypeScript (strict mode)         |
| 运行时    | Node.js >= 18                    |
| MCP SDK   | `@modelcontextprotocol/sdk` v1.x |
| Agent SDK | `@anthropic-ai/claude-agent-sdk` |
| 构建      | tsup (ESM bundle)                |
| 测试      | vitest                           |
| Schema    | zod v4                           |
| 格式化    | prettier                         |
| Lint      | eslint                           |
| Git hooks | husky + lint-staged              |

## 5. 项目结构

```
claude-code-mcp/
├── src/
│   ├── index.ts                # 入口，启动 MCP Server
│   ├── server.ts               # MCP Server 定义与工具注册
│   ├── types.ts                # 类型定义
│   ├── tools/
│   │   ├── claude-code.ts      # claude_code 工具
│   │   ├── claude-code-reply.ts # claude_code_reply 工具
│   │   ├── claude-code-session.ts # claude_code_session 工具
│   │   └── claude-code-configure.ts # claude_code_configure 工具
│   └── session/
│       └── manager.ts          # 会话管理器
├── tests/                      # 测试文件
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── .gitignore
├── LICENSE
├── CHANGELOG.md
├── DESIGN.md
└── README.md
```

## 6. 安全设计

- **bypassPermissions 门控**：默认禁用，可通过 `claude_code_configure` 工具在运行时启用
- **工具白/黑名单**：`allowedTools` / `disallowedTools`
- **费用控制**：`maxBudgetUsd` 限制单次费用
- **轮次限制**：`maxTurns` 防止无限循环
- **会话自动清理**：空闲 30 分钟 / 卡死 4 小时
- **AbortController 生命周期**：完成后清除，取消时正确 abort
- **取消语义**：cancelled 状态不会被后续 update 覆盖

## 7. 会话状态机

```
                 ┌──────────┐
    create() ──► │ running  │
                 └────┬─────┘
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
    ┌────────┐  ┌──────────┐  ┌───────────┐
    │  idle  │  │  error   │  │ cancelled │
    └────┬───┘  └──────────┘  └───────────┘
         │
    reply() ──► running ──► idle/error/cancelled
```

## 8. Turn/Cost 语义

- `numTurns` / `totalCostUsd`：**本次调用**（一次 `claude_code` 或一次 `claude_code_reply`）的增量
- `sessionTotalTurns` / `sessionTotalCostUsd`：该 session 的**累计值**（新会话时通常等于本次增量；reply 非 fork 会在原 session 上累计）
- 当 `forkSession=true` 时，返回的 `sessionId`（以及 `sessionTotal*`）对应 **fork 后的新 session**；原 session 的累计值保持不变

## 9. 错误码

参数校验/策略错误以 `Error [CODE]: message` 形式返回，`CODE` 取值：

- `INVALID_ARGUMENT`
- `SESSION_NOT_FOUND`
- `SESSION_BUSY`
- `PERMISSION_DENIED`
- `TIMEOUT`
- `CANCELLED`
- `INTERNAL`

Claude Agent SDK 的执行错误请同时查看 `errorSubtype`（如 `error_max_turns` / `error_max_budget_usd` / `error_during_execution`）以及返回的 `result` 文本。

## 10. 会话持久化说明

本 MCP server 的 `SessionManager` 仅在内存中保存 session 元数据（状态/累计 cost/turn/以及创建时的配置快照）。
Claude Code CLI 会把对话历史持久化到磁盘（通常在 `~/.claude/projects/`，由 SDK 管理）。

> 默认行为：`claude_code_reply` 需要该 session 仍存在于当前进程的 `SessionManager` 中；如果 MCP server 重启或 session 过期被清理，即使 CLI 的磁盘历史仍在，也会返回 `SESSION_NOT_FOUND`。
>
> 可选增强：设置 `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1` 后，`claude_code_reply` 会在内存缺失时尝试从磁盘 transcript 恢复。

### 10.1 会话清理参数（可选）

- `CLAUDE_CODE_MCP_SESSION_TTL_MS`（默认 1800000）
- `CLAUDE_CODE_MCP_RUNNING_SESSION_MAX_MS`（默认 14400000）
- `CLAUDE_CODE_MCP_CLEANUP_INTERVAL_MS`（默认 60000）
