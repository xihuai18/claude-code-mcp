# Claude Code MCP Server - 设计与接口文档

> Last Updated: 2026-02-27
>
> 本文档是项目的“实现级”设计说明，面向维护者和实现者。
> `AGENTS.md` 是执行手册；本文件是详细原理与契约权威来源。

## 1. 文档定位与去重边界

### 1.1 目标

本项目是一个 TypeScript (ESM) MCP server，将 Claude Agent SDK / Claude Code CLI 封装为 4 个 MCP 工具，提供：

- 最少工具（4 tools）
- 最少默认配置（默认即开箱）
- 最大 SDK 能力暴露（Options 尽量完整映射）
- 完全异步无阻塞执行（启动即返回 + 轮询）
- 完整权限治理（可见性 + allow/deny + 异步裁决）

### 1.2 文档主权表（Source of Truth）

| 信息类型                                       | 权威文档         | 说明                          |
| ---------------------------------------------- | ---------------- | ----------------------------- |
| 执行流程、提交前检查、升级 Runbook（操作清单） | `AGENTS.md`      | 面向“怎么做”                  |
| 架构原理、状态机、时序、字段语义               | `docs/DESIGN.md` | 面向“为什么这样做 + 具体契约” |
| 终端用户使用说明、参数释义示例                 | `README.md`      | 面向使用者                    |
| 版本历史                                       | `CHANGELOG.md`   | 面向发布与变更记录            |

### 1.3 去重规则

- `AGENTS.md` 不维护长参数表、消息映射表、协议长文。
- 本文件维护所有详细映射与语义边界。
- 两份文档允许少量摘要重复，但详细内容只能在一个地方出现。

### 1.4 Agent 可见性边界

对于“通过 MCP 接入的 code agent”，不要假设它能看到仓库文档：

- 通常可见：tool name / description、input schema 字段描述、client 主动读取的 MCP resources
- 不应假设可见：`README.md`、`docs/DESIGN.md`、`AGENTS.md`、`CHANGELOG.md`

因此，容易误用的运行时规则必须先落在：

1. `src/server.ts` 的 tool description 与字段 `.describe()`
2. `src/resources/register-resources.ts` 的 quickstart / gotchas / compat guidance
3. 然后才在 README / DESIGN 做人类文档补充

补充：Claude 可执行文件默认解析也属于运行时关键行为。若 schema / resource / README 不一致，以代码实现和启动时诊断为准。

## 2. 系统概览

### 2.1 工具与职责

| 工具                  | 职责                       | 阻塞行为                  |
| --------------------- | -------------------------- | ------------------------- |
| `claude_code`         | 启动新会话                 | 仅等待 init，随后后台运行 |
| `claude_code_reply`   | 继续会话 / fork / 磁盘恢复 | 立即返回，后台运行        |
| `claude_code_session` | list/get/cancel/interrupt  | 同步返回                  |
| `claude_code_check`   | 轮询事件 + 权限裁决        | 同步返回                  |

### 2.2 核心运行路径

1. `claude_code` / `claude_code_reply` 接收参数并构建 `Partial<Options>`
2. 交给 `query-consumer` 后台消费 SDK `query()` 异步流
3. 事件写入 `SessionManager` 的事件缓冲
4. 调用方用 `claude_code_check action=poll` 轮询增量事件
5. 需要授权时，调用方通过 `respond_permission` 做裁决
6. 终态为 `idle` / `error` / `cancelled`

### 2.3 关键代码锚点

- Schema 与工具注册：`src/server.ts`
- Options 映射中心：`src/utils/build-options.ts`
- SDK 消息消费与权限回调：`src/tools/query-consumer.ts`
- 会话状态与权限请求生命周期：`src/session/manager.ts`
- 共享类型与常量：`src/types.ts`
- 资源注册：`src/resources/register-resources.ts`

## SDK Interface Baseline

升级时以本地依赖安装后的类型定义为准：

- Claude Agent SDK：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- MCP SDK（必要时）：`node_modules/@modelcontextprotocol/sdk`

补充来源：

- 官方 changelog / release notes（仅用于“线索”，不是最终判据）

### 对齐原则

1. 直接映射到 SDK `Options` 的字段，参数名与 SDK 同名（通常 `camelCase`）。
2. 非 SDK 直传字段（例如 MCP action 枚举、服务端策略字段）保留现有契约名。
3. 默认不保留兼容别名；发生重命名时执行一次性切换，并同步文档与测试。
4. 冲突时，以 `sdk.d.ts` 和代码实现事实为准，文档追随实现。

### 关键 SDK 接口关注面

- `Options` 字段全集
- `CanUseTool` 回调签名与行为
- `PermissionMode` 枚举
- `SDKMessage` / `SDKResultMessage` / `SDKSystemMessage` 联合类型
- `query()` 流式语义（init、assistant、progress、result、error）

## 4. MCP 参数到 SDK Options 映射矩阵

> 维护原则：每次 SDK 升级都必须核对并更新本节；这是“字段级”对齐清单。

### 4.1 `claude_code` / `claude_code_reply` 常见映射

| MCP 参数位置                          | SDK Options 字段             | 映射落点            | 默认值来源                                                                                |
| ------------------------------------- | ---------------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `cwd`                                 | `cwd`                        | `build-options.ts`  | Server cwd                                                                                |
| `allowedTools`                        | `allowedTools`               | `build-options.ts`  | none                                                                                      |
| `disallowedTools`                     | `disallowedTools`            | `build-options.ts`  | none                                                                                      |
| `maxTurns`                            | `maxTurns`                   | `build-options.ts`  | SDK                                                                                       |
| `model`                               | `model`                      | `build-options.ts`  | SDK                                                                                       |
| `effort`                              | `effort`                     | `build-options.ts`  | SDK                                                                                       |
| `thinking`                            | `thinking`                   | `build-options.ts`  | SDK                                                                                       |
| `systemPrompt`                        | `systemPrompt`               | `build-options.ts`  | SDK                                                                                       |
| `permissionRequestTimeoutMs`          | (server policy)              | `query-consumer.ts` | 60000，clamp 到 300000                                                                    |
| `advanced.tools`                      | `tools`                      | `build-options.ts`  | SDK                                                                                       |
| `advanced.agents`                     | `agents`                     | `build-options.ts`  | SDK                                                                                       |
| `advanced.agent`                      | `agent`                      | `build-options.ts`  | SDK                                                                                       |
| `advanced.maxBudgetUsd`               | `maxBudgetUsd`               | `build-options.ts`  | SDK                                                                                       |
| `advanced.betas`                      | `betas`                      | `build-options.ts`  | SDK                                                                                       |
| `advanced.additionalDirectories`      | `additionalDirectories`      | `build-options.ts`  | SDK                                                                                       |
| `advanced.outputFormat`               | `outputFormat`               | `build-options.ts`  | SDK                                                                                       |
| `advanced.pathToClaudeCodeExecutable` | `pathToClaudeCodeExecutable` | `build-options.ts`  | request override > env path > env command > auto `claude`/`claude-internal` > SDK-bundled |
| `advanced.mcpServers`                 | `mcpServers`                 | `build-options.ts`  | SDK                                                                                       |
| `advanced.sandbox`                    | `sandbox`                    | `build-options.ts`  | SDK                                                                                       |
| `advanced.fallbackModel`              | `fallbackModel`              | `build-options.ts`  | SDK                                                                                       |
| `advanced.enableFileCheckpointing`    | `enableFileCheckpointing`    | `build-options.ts`  | SDK                                                                                       |
| `advanced.toolConfig`                 | `toolConfig`                 | `build-options.ts`  | SDK                                                                                       |
| `advanced.includePartialMessages`     | `includePartialMessages`     | `build-options.ts`  | SDK                                                                                       |
| `advanced.promptSuggestions`          | `promptSuggestions`          | `build-options.ts`  | false                                                                                     |
| `advanced.agentProgressSummaries`     | `agentProgressSummaries`     | `build-options.ts`  | false                                                                                     |
| `advanced.strictMcpConfig`            | `strictMcpConfig`            | `build-options.ts`  | SDK                                                                                       |
| `advanced.settings`                   | `settings`                   | `build-options.ts`  | SDK                                                                                       |
| `advanced.settingSources`             | `settingSources`             | `build-options.ts`  | `["user","project","local"]`                                                              |
| `advanced.debug`                      | `debug`                      | `build-options.ts`  | false                                                                                     |
| `advanced.debugFile`                  | `debugFile`                  | `build-options.ts`  | none                                                                                      |
| `advanced.env`                        | `env`                        | `build-options.ts`  | `{...process.env, ...input.env}`                                                          |

### 4.2 `claude_code_reply.diskResumeConfig` 映射

`diskResumeConfig` 共享同一套 `buildOptions()` 逻辑，额外关注：

- `resumeToken` 是本项目安全策略字段，不属于 SDK `Options`
- `resumeSessionAt` 仅在恢复场景使用
- `forkSession` 是 reply 行为字段，非 `diskResumeConfig` 内配置

### 4.3 非 Options 直传字段（服务端策略）

| 字段                                                   | 所属工具                                    | 语义               |
| ------------------------------------------------------ | ------------------------------------------- | ------------------ |
| `action`                                               | `claude_code_check` / `claude_code_session` | MCP 协议动作分支   |
| `requestId` / `decision` / `interrupt` / `denyMessage` | `claude_code_check`                         | 权限请求裁决协议   |
| `pollOptions`                                          | `claude_code_check`                         | 返回裁剪与体积控制 |
| `includeSensitive`                                     | `claude_code_session`                       | 会话信息脱敏开关   |
| `sessionInitTimeoutMs`                                 | `claude_code` / `claude_code_reply`         | init 等待策略      |

## 5. SDK 消息到 MCP 事件映射矩阵

> 维护原则：每次 SDK 新增/变更消息 subtype，都必须评估是否需要映射或过滤。

### 5.1 消息映射（`query-consumer.ts`）

| SDK Message                   | MCP 事件类型              | 关键字段                                                                                   | 备注                                      |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `assistant`                   | `output`                  | `message`, `parent_tool_use_id`, `error`                                                   | 主要文本输出                              |
| `stream_event`                | `output`                  | `event`, `parent_tool_use_id`                                                              | 仅在 `includePartialMessages=true` 时出现 |
| `system/local_command_output` | `output`                  | `content`                                                                                  | 本地 slash command 输出                   |
| `tool_use_summary`            | `progress`                | `summary`                                                                                  | 工具执行摘要                              |
| `tool_progress`               | `progress`                | `tool_use_id`, `tool_name`, `parent_tool_use_id`, `task_id`, `elapsed_time_seconds`        | 可在 minimal 过滤                         |
| `auth_status`                 | `progress`                | `isAuthenticating`, `output`, `error`                                                      | 可在 minimal 过滤                         |
| `system/status`               | `progress`                | `status`, `permissionMode`                                                                 | 系统状态                                  |
| `system/compact_boundary`     | `progress`                | `compact_metadata`                                                                         | 会话压缩边界                              |
| `system/hook_started`         | `progress`                | `hook_id`, `hook_name`, `hook_event`                                                       | hook 开始                                 |
| `system/hook_progress`        | `progress`                | `hook_id`, `hook_name`, `hook_event`, `stdout`, `stderr`, `output`                         | hook 进度（可在 minimal 过滤）            |
| `system/hook_response`        | `progress`                | `hook_id`, `hook_name`, `hook_event`, `outcome`, `exit_code`, `stdout`, `stderr`, `output` | hook 终态结果                             |
| `system/files_persisted`      | `progress`                | `files`, `failed`, `processed_at`                                                          | 文件持久化结果                            |
| `system/api_retry`            | `progress`                | `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error`                        | API 重试（可在 minimal 过滤）             |
| `system/task_started`         | `progress`                | `task_id`, `tool_use_id`, `description`, `task_type`, `prompt?`                            | 子任务开始                                |
| `system/task_progress`        | `progress`                | `task_id`, `tool_use_id`, `description`, `usage`, `last_tool_name`, `summary?`             | 子任务进度（可在 minimal 过滤）           |
| `system/task_notification`    | `progress`                | `task_id`, `tool_use_id`, `status`, `summary`, `output_file`, `usage?`                     | 子任务状态                                |
| `system/elicitation_complete` | `progress`                | `mcp_server_name`, `elicitation_id`                                                        | MCP URL/form elicitation 完成             |
| `rate_limit_event`            | `progress`                | `rate_limit_info`                                                                          | 速率限制状态                              |
| `prompt_suggestion`           | `progress`                | subtype 原字段                                                                             | 需开启 promptSuggestions                  |
| `result/success`              | 顶层 `result`             | turns/cost/usage/result/`fastModeState?`                                                   | 终态成功                                  |
| `result/error_*`              | 顶层 `result` + `isError` | `errorSubtype` + 错误文本 + `fastModeState?`                                               | 终态失败                                  |

### 5.2 `responseMode` 与 `pollOptions` 裁剪语义

- `minimal`（默认）：返回轻量字段，过滤部分进度事件与冗余 usage 元数据
- `full`：尽量完整返回
- `delta_compact`：增量压缩导向
- `pollOptions.include*`：对结果与事件逐项开关；用于精细控制带宽

### 5.3 权限请求事件

当 `canUseTool` 触发裁决时：

1. 生成 pending request（含超时）
2. 会话进入 `waiting_permission`
3. `claude_code_check poll` 返回 `actions[]`
4. `respond_permission` 处理 allow/deny/allow_for_session（`allow_for_session` 优先采用 SDK `suggestions`，否则回退到通用 session allow rule）
5. request 幂等收尾（respond/timeout/cancel/signal 任一路径只会完成一次）

## 6. 状态机与生命周期

### 6.1 会话状态机

```text
running <-> waiting_permission -> idle | error | cancelled
```

- `cancelled` 为终态，不可继续回复
- `reply` 需要会话可被重新 acquire（`tryAcquire`）

### 6.2 清理策略

- 空闲会话 TTL：默认 30 分钟
- 运行会话硬超时：默认 4 小时（超时后 force abort 并标记 `cancelled`）

### 6.3 事件缓冲策略

- 软上限：`CLAUDE_CODE_MCP_EVENT_BUFFER_MAX_SIZE`（默认 1000）
- 硬上限：`CLAUDE_CODE_MCP_EVENT_BUFFER_HARD_MAX_SIZE`（默认 2000）
- 关键事件 pin（权限请求、权限结果、错误）优先保留

## 7. 安全模型

### 7.1 三层权限防护

1. 可见性层：`advanced.tools`
2. 硬策略层：`allowedTools` / `disallowedTools`
3. 交互裁决层：`canUseTool` + `claude_code_check respond_permission`

### 7.2 数据与信息安全

- `advanced.env` 不会出现在公开 session 信息中
- `settings` 始终不出现在 session JSON 中（避免把高优先级 flag settings 当作可安全回显配置）
- `includeSensitive=false` 默认脱敏 `cwd/systemPrompt/agents/additionalDirectories/toolConfig`
- `resumeToken` 依赖 `CLAUDE_CODE_MCP_RESUME_SECRET` 的 HMAC 校验

## Upgrade Methodology

### 触发条件

- 升级 `@anthropic-ai/claude-agent-sdk`
- 升级 `@modelcontextprotocol/sdk`
- 升级引起 zod schema、消息联合类型、权限模式、工具发现行为变化

### 变更分类

1. 字段新增：新增映射与 schema 描述，并补测试
2. 字段重命名：一次性切换，移除旧名，不留长期别名
3. 语义变化：更新行为逻辑与文档语义
4. 字段移除：删除映射、参数与测试，更新兼容提示
5. 消息类型变化：更新 query consumer 映射和 poll 裁剪策略

### 升级核对顺序

1. 阅读 `sdk.d.ts` / SDK 类型定义
2. 对照本文件第 4 节（Options 映射矩阵）
3. 对照本文件第 5 节（消息映射矩阵）
4. 同步修改：
   - `src/server.ts`（zod schema / describe）
   - `src/utils/build-options.ts`（字段复制与默认）
   - `src/tools/query-consumer.ts`（消息映射与权限行为）
   - `src/session/manager.ts`（状态与权限请求生命周期）
   - `src/types.ts`（共享类型与枚举）
5. 更新文档与变更记录：`README.md`、`docs/DESIGN.md`、`AGENTS.md`、`CHANGELOG.md`
6. 运行检查：`typecheck` / `lint` / `test` / `format:check`

### 升级验收标准

- 所有直传字段均有 schema + 映射 + 测试
- 新消息 subtype 的处理决策明确（映射/忽略/过滤）
- 无过期参数名与旧别名残留
- 文档与代码一致

### 升级提交模板（建议）

当升级影响接口时，建议在 PR 描述固定包含：

1. 变更输入：升级了哪些依赖版本
2. 类型基线：核对了哪些 `sdk.d.ts` 位置
3. 字段对齐：新增/变更/移除了哪些 Options 映射
4. 消息对齐：新增/变更/忽略了哪些 SDK 消息 subtype
5. 代码触点：改动了哪些核心文件（`server.ts`, `build-options.ts`, `query-consumer.ts`, `manager.ts`, `types.ts`）
6. 测试覆盖：新增或更新了哪些测试文件
7. 文档闭环：同步更新了哪些文档（README/DESIGN/AGENTS/CHANGELOG）

### 文档 DoD（Definition of Done）

文档更新满足以下条件才算完成：

- `AGENTS.md` 与 `docs/DESIGN.md` 的边界声明保持一致
- `AGENTS.md` 未出现长参数表/消息映射表的重复内容
- `docs/DESIGN.md` 的 Options 映射矩阵与消息映射矩阵与代码一致
- 锚点 `#sdk-interface-baseline` 与 `#upgrade-methodology` 可从 AGENTS 跳转
- `CHANGELOG.md` 的 Documentation 分组记录了本次文档结构变化

## 9. 测试矩阵（接口变更相关）

| 变更类型                    | 最低测试覆盖                                                              |
| --------------------------- | ------------------------------------------------------------------------- |
| 参数 schema 变化            | `tests/server.test.ts`, `tests/tools.test.ts`                             |
| Options 映射变化            | `tests/build-options.test.ts`, 相关 tool tests                            |
| 消息映射变化                | `tests/query-consumer.test.ts`, `tests/claude-code-check.test.ts`         |
| 权限生命周期变化            | `tests/session-manager.test.ts`, `tests/permission-updated-input.test.ts` |
| resume token / 恢复流程变化 | `tests/resume-token.test.ts`, `tests/claude-code-reply.test.ts`           |
| tool discovery 变化         | `tests/tool-discovery.test.ts`, `tests/resources.test.ts`                 |

## 10. API 语义与兼容策略

### 10.1 命名策略

- SDK 直传字段保持同名
- 项目策略字段保留契约名

### 10.2 兼容策略

- 默认不维持旧字段别名
- 如需破坏性变更，版本说明必须清晰，并同步全部文档与测试

### 10.3 错误表达

工具 handler 统一返回 `{ content, isError }`，不向 MCP 层直接抛异常。
错误消息使用 `Error [CODE]: message` 格式，`CODE` 由 `ErrorCode` 统一管理。

### 10.4 OpenCode 导向用法

- 把 `claude_code` + `claude_code_check` 视为一个异步 job API：启动一次、持续轮询、显式处理权限。
- 默认优先 `claude_code_check(responseMode="delta_compact")`，减少聊天上下文噪音和 payload 体积。
- 当同一工具会重复触发审批时，优先使用 `decision="allow_for_session"`，比每次 `allow` 更适合 OpenCode 的交互节奏；若 SDK 已提供 `suggestions`，服务端会优先沿用这些更具体的更新。
- 默认继续保持 `includeSensitive=false`；OpenCode 如需调试会话上下文，再显式读取 `claude_code_session(includeSensitive=true)`。

## 11. 附录 A：MCP 协议要点（简版）

- 协议：JSON-RPC 2.0
- 三类消息：Request / Response / Notification
- 本项目使用 stdio 传输
- 已使用能力：tools、resources、logging

> 历史上的详细生态对比与客户端能力差异，应放在 README 或专项调研文档，避免污染设计主干。

## 12. 附录 B：对 `AGENTS.md` 的引用锚点

`AGENTS.md` 可引用本文件的关键锚点：

- SDK 权威接口：`#sdk-interface-baseline`
- 升级方法学：`#upgrade-methodology`
- Options 映射矩阵：第 4 节
- 消息映射矩阵：第 5 节
