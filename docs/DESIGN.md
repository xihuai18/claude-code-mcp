# Claude Code MCP Server - 设计文档

## 1. 概述

本项目实现一个 MCP (Model Context Protocol) Server，将 Claude Code (Claude Agent SDK) 的能力暴露为 MCP 工具，使任何 MCP 客户端（如 Claude Desktop、Cursor、其他 AI Agent）能够调用 Claude Code 进行自主编程。

### 设计哲学

参考 OpenAI Codex MCP 的极简设计（仅 `codex` + `codex-reply` 两个工具），本项目采用 **最少工具、最大能力** 的原则：

- **工具数量精简**：仅暴露 4 个工具，覆盖完整生命周期
- **会话状态管理**：通过 sessionId 维护多轮对话上下文
- **配置灵活**：支持权限、模型、工具集、effort 等细粒度控制
- **可审计**：所有操作可追踪

## 1.1 接口对齐与升级规范（本次约定）

- 以 Claude Agent SDK 的接口定义为准（`Options` 字段、permission mode 枚举、query stream 消息类型），实现与文档必须严格对齐。
- 升级 SDK 时，先阅读仓库文档获取上下文，再逐项对照 SDK 类型定义核对变化；发生冲突时以 SDK 定义为最终判据。升级日志仅作辅助，不作为唯一判断依据。
- 参数命名采用“直传字段同名”策略：直接映射 SDK `Options` 的字段与 SDK 保持同名（通常 `camelCase`）；非 SDK 直传字段沿用本项目既有契约名，不强制改名。
- 默认不保留旧字段兼容别名；采用“直接对齐 + 全链路同步”策略，避免双写字段长期共存。
- 每次接口变化必须同步更新：工具 schema、handler、SessionManager、`build-options`、`query-consumer`、类型定义、README、DESIGN、AGENTS、CHANGELOG 与测试。
- 建议使用多智能体并行探索进行差异确认，并在收尾阶段做一次独立交叉验证。

## 2. 工具设计

### Tool 1: `claude_code` — 启动新会话

启动一个新的 Claude Code Agent 会话，执行编程任务。

| 参数              | 类型     | 必需 | 说明                                                        |
| ----------------- | -------- | ---- | ----------------------------------------------------------- |
| `prompt`          | string   | 是   | 用户提示/任务描述                                           |
| `cwd`             | string   | 否   | 工作目录，默认为服务器进程目录                              |
| `allowedTools`    | string[] | 否   | 自动批准工具列表（未在 allow/deny 中的工具可能通过 `claude_code_check` 发起权限请求） |
| `disallowedTools` | string[] | 否   | 工具黑名单（从可用工具集中剔除）                            |
| `maxTurns`        | number   | 否   | 最大对话轮次                                                |
| `model`           | string   | 否   | 模型选择                                                    |
| `systemPrompt`    | string / object | 否 | 自定义系统提示 (字符串或 preset 对象)                       |
| `permissionRequestTimeoutMs` | number | 否 | 等待权限裁决的超时 (毫秒)，默认 60000（服务端上限 300000） |
| `advanced`        | object   | 否   | 低频高级参数（见下方折叠表）                                |

<details>
<summary><code>advanced</code> 对象参数（21 个低频参数）</summary>

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `advanced.tools` | string[] / object | 可用工具集 (工具名数组或 preset) |
| `advanced.persistSession` | boolean | 是否将会话历史持久化到磁盘（`~/.claude/projects/`，默认 true；设为 false 可禁用） |
| `advanced.sessionInitTimeoutMs` | number | 等待 `system/init` 的超时 (毫秒)，默认 10000 |
| `advanced.agents` | object | 子 Agent 定义 |
| `advanced.agent` | string | 主线程 agent 名称（应用自定义 agent 系统提示、工具限制和模型） |
| `advanced.maxBudgetUsd` | number | 最大费用限制 (USD) |
| `advanced.betas` | string[] | Beta 功能 (如 1M 上下文) |
| `advanced.additionalDirectories` | string[] | 额外可访问目录 |
| `advanced.outputFormat` | object | 输出格式: `{ type: "json_schema", schema: {...} }` |
| `advanced.pathToClaudeCodeExecutable` | string | Claude Code 可执行文件路径 |
| `advanced.mcpServers` | object | MCP 服务器配置（key: 服务器名, value: 服务器配置） |
| `advanced.sandbox` | object | 沙箱设置（命令执行隔离） |
| `advanced.fallbackModel` | string | 备用模型（主模型不可用时使用） |
| `advanced.enableFileCheckpointing` | boolean | 启用文件检查点（跟踪文件变更） |
| `advanced.includePartialMessages` | boolean | 控制底层 SDK 是否产出更多中间事件（通过 `claude_code_check` 的 events 轮询可见） |
| `advanced.promptSuggestions` | boolean | 产出 `prompt_suggestion` 事件（默认 false） |
| `advanced.strictMcpConfig` | boolean | 严格验证 MCP 服务器配置 |
| `advanced.settingSources` | string[] | 控制加载哪些文件系统设置 ("user"/"project"/"local")，默认加载全部 `["user", "project", "local"]`，传 `[]` 可切换为 SDK 隔离模式 |
| `advanced.debug` | boolean | 启用调试模式 |
| `advanced.debugFile` | string | 调试日志文件路径（隐式启用调试模式） |
| `advanced.env` | object | 传递给 Claude Code 进程的环境变量 |
</details>

**返回值**：`{ sessionId, status: "running", pollInterval }`

调用方需通过 `claude_code_check` 轮询获取最终 `result`。

### Tool 2: `claude_code_reply` — 继续已有会话

| 参数          | 类型    | 必需 | 说明               |
| ------------- | ------- | ---- | ------------------ |
| `sessionId`   | string  | 是   | 要继续的会话 ID    |
| `prompt`      | string  | 是   | 后续提示           |
| `forkSession` | boolean | 否   | 是否 fork 到新会话 |
| `permissionRequestTimeoutMs` | number | 否 | 等待权限裁决的超时 (毫秒)，默认 60000（服务端上限 300000） |
| `sessionInitTimeoutMs` | number | 否 | 等待 fork `system/init` 的超时 (毫秒)，默认 10000 |
| `diskResumeConfig` | object | 否 | 磁盘恢复参数（见下方折叠表） |

<details>
<summary><code>diskResumeConfig</code> 对象参数（31 个仅磁盘恢复场景参数，当 <code>CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1</code> 且内存中 session 缺失时使用）</summary>

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `diskResumeConfig.resumeToken` | string | 恢复令牌（磁盘恢复必需） |
| `diskResumeConfig.cwd` | string | 工作目录 |
| `diskResumeConfig.allowedTools` | string[] | 自动批准工具列表 |
| `diskResumeConfig.disallowedTools` | string[] | 工具黑名单 |
| `diskResumeConfig.strictAllowedTools` | boolean | `allowedTools` 严格白名单语义 |
| `diskResumeConfig.tools` | string[] / object | 可用工具集 |
| `diskResumeConfig.persistSession` | boolean | 是否持久化会话历史 |
| `diskResumeConfig.maxTurns` | number | 最大对话轮次 |
| `diskResumeConfig.model` | string | 模型选择 |
| `diskResumeConfig.systemPrompt` | string / object | 自定义系统提示 |
| `diskResumeConfig.agents` | object | 子 Agent 定义 |
| `diskResumeConfig.agent` | string | 主线程 agent 名称 |
| `diskResumeConfig.maxBudgetUsd` | number | 最大费用限制 (USD) |
| `diskResumeConfig.effort` | string | 努力程度 |
| `diskResumeConfig.betas` | string[] | Beta 功能 |
| `diskResumeConfig.additionalDirectories` | string[] | 额外可访问目录 |
| `diskResumeConfig.outputFormat` | object | 输出格式 |
| `diskResumeConfig.thinking` | object | 思考模式 |
| `diskResumeConfig.resumeSessionAt` | string | 恢复到指定消息 UUID |
| `diskResumeConfig.pathToClaudeCodeExecutable` | string | Claude Code 可执行文件路径 |
| `diskResumeConfig.mcpServers` | object | MCP 服务器配置 |
| `diskResumeConfig.sandbox` | object | 沙箱设置 |
| `diskResumeConfig.fallbackModel` | string | 备用模型 |
| `diskResumeConfig.enableFileCheckpointing` | boolean | 启用文件检查点 |
| `diskResumeConfig.includePartialMessages` | boolean | 包含部分/流式消息事件 |
| `diskResumeConfig.promptSuggestions` | boolean | 产出 `prompt_suggestion` 事件（默认 false） |
| `diskResumeConfig.strictMcpConfig` | boolean | 严格验证 MCP 服务器配置 |
| `diskResumeConfig.settingSources` | string[] | 文件系统设置来源 |
| `diskResumeConfig.debug` | boolean | 调试模式 |
| `diskResumeConfig.debugFile` | string | 调试日志文件路径 |
| `diskResumeConfig.env` | object | 环境变量 |

</details>

**返回值**：`{ sessionId, status: "running", pollInterval }`

调用方需通过 `claude_code_check` 轮询获取最终 `result`。

> 可选增强：当设置 `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1` 时，如果内存中的 session 元数据丢失（重启/TTL 清理），`claude_code_reply` 会尝试使用 Claude Code CLI 的磁盘 transcript 进行恢复；此时需传入 `diskResumeConfig` 对象以控制恢复行为。

### Tool 3: `claude_code_session` — 会话管理

| 参数               | 类型    | 必需          | 说明            |
| ------------------ | ------- | ------------- | --------------- |
| `action`           | string  | 是            | list/get/cancel/interrupt |
| `sessionId`        | string  | get/cancel/interrupt 时 | 目标会话 ID     |
| `includeSensitive` | boolean | 否            | 是否包含敏感字段（cwd/systemPrompt/agents/additionalDirectories，默认 false） |

**返回值**：`{ sessions, message?, isError? }`（默认会对敏感字段做脱敏；`includeSensitive=true` 时返回完整字段）

### Tool 4: `claude_code_check` — 轮询事件 + 处理权限请求

| 参数 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `action` | string | 是 | poll / respond_permission |
| `sessionId` | string | 是 | 目标会话 ID |
| `cursor` | number | 否 | 事件 cursor（增量轮询） |
| `responseMode` | string | 否 | `"minimal"`（默认）/`"full"`/`"delta_compact"` — 控制返回体积和裁剪行为 |
| `maxEvents` | number | 否 | 每次轮询最大事件数。`minimal` 默认 200，`full`/`delta_compact` 默认 unlimited |
| `requestId` | string | respond_permission 时 | 权限请求 ID |
| `decision` | string | respond_permission 时 | allow / deny / allow_for_session |
| `denyMessage` | string | 否 | deny 的原因 |
| `interrupt` | boolean | 否 | deny 时是否中断整个 agent |
| `pollOptions` | object | 否 | 细粒度 poll 控制（见下方折叠表） |
| `permissionOptions` | object | 否 | 高级权限响应选项（见下方折叠表） |

<details>
<summary><code>pollOptions</code> 对象参数（10 个细粒度 poll 控制）</summary>

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `pollOptions.includeTools` | boolean | 是否返回 availableTools（来自 SDK 的 system/init.tools，内部能力可能不会出现） |
| `pollOptions.includeEvents` | boolean | 为 false 时省略 events 数组。默认 true |
| `pollOptions.includeActions` | boolean | 为 false 时省略 actions[]。默认 true |
| `pollOptions.includeResult` | boolean | 为 false 时省略顶层 result。默认 true |
| `pollOptions.includeUsage` | boolean | 包含 result.usage（full=true, minimal=false） |
| `pollOptions.includeModelUsage` | boolean | 包含 result.modelUsage（full=true, minimal=false） |
| `pollOptions.includeStructuredOutput` | boolean | 包含 result.structuredOutput（full=true, minimal=false） |
| `pollOptions.includeTerminalEvents` | boolean | 包含终端 result/error 事件（full=true, minimal=false） |
| `pollOptions.includeProgressEvents` | boolean | 包含进度事件 tool_progress/auth_status（full=true, minimal=false） |
| `pollOptions.maxBytes` | number | 单次返回 events 的近似 JSON 字节上限；超出时截断并在 `truncatedFields` 标记 `events_bytes` |

</details>

<details>
<summary><code>permissionOptions</code> 对象参数（2 个高级权限响应选项）</summary>

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `permissionOptions.updatedInput` | object | allow 或 allow_for_session 时可修改工具输入 |
| `permissionOptions.updatedPermissions` | array | allow 或 allow_for_session 时可更新权限规则 |

</details>

**返回值**：统一事件流结构 `{ sessionId, status, pollInterval?, cursorResetTo?, truncated?, truncatedFields?, events, nextCursor?, availableTools?, toolValidation?, compatWarnings?, actions?, result? }`。

> minimal 模式（默认）下：assistant 消息精简（去除 usage/model/id/cache_control）；过滤 tool_progress/auth_status 进度事件；省略 lastEventId/lastToolUseId；AgentResult 省略 durationApiMs/sessionTotalTurns/sessionTotalCostUsd。使用 `responseMode: "full"` 或单独的 `include*` 标志可恢复。
>
> 权限请求 `actions[]` 会包含 `timeoutMs` / `expiresAt` / `remainingMs`（尽力计算）用于调用方展示倒计时；到期后会自动 deny。
>
> `compatWarnings` 属于兼容性提示（warning），默认不阻断会话执行（例如 unknown allowed/disallowed tool 名称）。
>
> `events=[]` 且 `nextCursor` 不变可能是正常瞬态空轮询；建议按同一 cursor 重试最多 3 次后再判定异常。
>
> Windows 场景下，若权限请求中出现 `/home/user/...` 路径，建议改用当前 `cwd` 下的绝对 Windows 路径（如 `C:\\repo\\...`），以减少越界权限请求。

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
│   │   ├── claude-code-check.ts # claude_code_check 工具
│   │   ├── query-consumer.ts   # 共享后台 query 消费逻辑
│   │   └── tool-discovery.ts   # 运行时工具发现 + 动态描述生成
│   ├── session/
│   │   └── manager.ts          # 会话管理器
│   └── utils/
│       ├── build-options.ts    # 共享 SDK Options 构建逻辑
│       ├── race-with-abort.ts  # Promise 与 AbortSignal 竞争
│       ├── resume-token.ts     # HMAC 恢复令牌生成
│       └── windows.ts          # Git Bash 检测，Windows 错误提示
├── tests/                      # 测试文件
├── docs/                       # 设计文档、重构日志
├── mcp_demo/                   # MCP 客户端配置示例
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── .gitignore
├── LICENSE
├── CHANGELOG.md
└── README.md
```

## 6. 安全设计

- **异步权限裁决**：当工具调用需要授权时，会话进入 waiting_permission 并通过 `claude_code_check` 返回 actions[]，调用方需 respond_permission 批准/拒绝
- **工具白/黑名单**：`allowedTools` / `disallowedTools`
> 重要：若使用 `agents`（子 agent），主 agent 需要具备 `Task` 工具权限，否则无法调用子 agent。
- **费用控制**：`advanced.maxBudgetUsd` 限制单次费用
- **轮次限制**：`maxTurns` 防止无限循环
- **会话自动清理**：空闲 30 分钟自动删除；运行超时（4 小时）会被标记为 `cancelled`
- **AbortController 生命周期**：完成后清除，取消时正确 abort
- **取消语义**：cancelled 状态不会被后续 update 覆盖

## 7. 会话状态机

```
                 ┌──────────┐
    create() ──► │ running  │
                 └────┬─────┘
                      │
         ┌────────────┼────────────┬────────────┐
          ▼            ▼            ▼
     ┌─────────────────────┐
     │ waiting_permission   │
     └──────────┬──────────┘
                │
                ▼
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
- `PERMISSION_REQUEST_NOT_FOUND`
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

### 10.1 会话清理

会话在空闲 30 分钟后自动清理，运行中的会话最长保留 4 小时。
