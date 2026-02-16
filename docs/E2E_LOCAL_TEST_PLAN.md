# claude-code-mcp 本地端到端测试方案（第三方 CLI 集成后）

本方案面向“已经在某个第三方 MCP Client/CLI 中安装并启用本 MCP Server”的场景，目标是验证：

- 该 MCP Server 在真实编程任务中可用（读写文件、运行命令、处理权限、轮询结果、继续会话等）
- 各类边界能力可用（权限超时、deny/interrupt、fork、cancel、disk-resume、Windows Git Bash、事件游标分页等）
- 回归测试可复用（同一套用例适用于 Claude Code CLI / OpenAI Codex CLI / Cursor / VS Code 等）

> 术语：本项目提供 4 个 MCP 工具：`claude_code` / `claude_code_reply` / `claude_code_check` / `claude_code_session`。会话事件通过 `claude_code_check` 轮询获取。

---

## 0. 测试覆盖与“通过标准”

**最低通过标准（必须全部满足）**

1. 第三方 Client 能启动本 MCP Server，并成功完成 MCP 初始化握手
2. 能完成一次完整生命周期：`claude_code` 启动 → `claude_code_check` 轮询 → 得到最终 `result`（session 进入 `idle` 或 `error`）
3. 权限闭环可用：能进入 `waiting_permission`，并通过 `claude_code_check respond_permission` allow/deny 后继续推进
4. 会话管理可用：`claude_code_session list/get/cancel` 行为符合预期
5. 真实编程任务至少完成 1 个：在独立测试仓库中修复一个可复现 bug，并在本地测试命令中通过

**推荐扩展覆盖（建议全部跑完做回归）**

- fork、继续会话（reply）、disk-resume、maxTurns/maxBudget、事件游标分页、`includeTools` 工具发现、Windows Git Bash 路径提示

**推荐执行顺序（P0 冒烟集合）**

1. `C01`（握手 + tools/resources 可发现）
2. `C03`（启动 → 轮询 → 终态 result）
3. `P01` + `P02`（权限 allow/deny 闭环）
4. `P05`（allowedTools/disallowedTools 基线）
5. `S01` + `S02`（list/get/cancel 基线）
6. `T01`（真实编程任务：修复失败测试并通过）

**Teardown（每轮回归结束必须做）**

- 对所有仍处于 `running/waiting_permission` 的 session 执行 `claude_code_session action="cancel"`，避免 session 泄漏与后续干扰

---

## 1. 前置条件（强制）

### 1.1 运行时与依赖

- Node.js `>= 18`
- 本机已完成 Claude Code 配置（API key、登录状态等）。本 MCP Server 使用 `@anthropic-ai/claude-agent-sdk` 的 SDK-bundled Claude Code CLI，但**读取与你系统 `claude` 相同的本地配置目录**（通常在 `~/.claude/`）。

### 1.2 Windows 额外要求

- 必须可用 Git Bash（Claude Code 在 Windows 需要 `bash.exe`）。
- 如自动检测失败，在 Client 的 MCP server 配置里加环境变量：
  - `CLAUDE_CODE_GIT_BASH_PATH=C:\Program Files\Git\bin\bash.exe`（以实际安装路径为准）

### 1.3 费用与失控防护（建议）

为避免回归测试跑飞，建议在 E2E 用例里统一启用：

- `maxTurns`（例如 6～12）
- `advanced.maxBudgetUsd`（例如 0.2～1.0）
- 仅在需要时开启 `WebSearch/WebFetch`

---

## 2. 安装与集成（第三方 CLI / Client）

本项目发布包名：`@leo000001/claude-code-mcp`，可执行命令：`claude-code-mcp`。

### 2.1 通用安装方式（推荐 npx）

- 使用 `npx`（最适合回归，避免全局污染）：
  - `npx -y @leo000001/claude-code-mcp`
- 或全局安装：
  - `npm install -g @leo000001/claude-code-mcp`
  - 运行：`claude-code-mcp`

### 2.2 Anthropic Claude Code CLI（作为 MCP Client）

```bash
claude mcp add --transport stdio claude-code -- npx -y @leo000001/claude-code-mcp
```

### 2.3 OpenAI Codex CLI（作为 MCP Client）

```bash
codex mcp add claude-code -- npx -y @leo000001/claude-code-mcp
```

或在 `~/.codex/config.toml`：

```toml
[mcp_servers.claude-code]
command = "npx"
args = ["-y", "@leo000001/claude-code-mcp"]
```

### 2.4 JSON 配置类 Client（Claude Desktop / Cursor / VS Code MCP）

```json
{
  "mcpServers": {
    "claude-code": {
      "command": "npx",
      "args": ["-y", "@leo000001/claude-code-mcp"]
    }
  }
}
```

---

## 3. 测试准备：创建独立“真实编程任务”沙盒仓库（推荐）

目标：让 E2E 测试不污染本仓库，同时能用“本地单元测试命令”验收产出。

### 3.1 推荐沙盒结构

- 建议创建一个全新目录，例如 `~/tmp/claude-code-mcp-e2e/`（或 Windows：`D:\tmp\claude-code-mcp-e2e\`）
- 里面放 2～3 个小项目（每个项目可独立运行测试）：
  - `node-vitest-bug/`：Node + Vitest，包含 1 个失败用例
  - `python-unittest-bug/`：Python unittest，包含 1 个失败用例
  - `multi-module-refactor/`：多文件小工程，用于 refactor 与子 agent 场景

### 3.2 “最小 Node+Vitest 失败用例”示例（手工创建）

创建 `node-vitest-bug/`：

- `src/sum.ts`（刻意写错，例如把加法写成减法）
- `tests/sum.test.ts`（断言 `sum(1,2)===3`）
- `package.json`（含 `vitest` 脚本）

验收命令：

```bash
npm test
```

通过标准：agent 修复后，`npm test` 退出码为 0。

---

## 4. 端到端用例矩阵（工具/协议级）

下面的用例默认在第三方 Client 中执行（它会通过 MCP 调用这些工具）。如果你的 Client 支持“显式调用 MCP tool”，建议按“步骤”逐条执行；如果不支持显式 tool 调用，可把步骤描述直接粘贴给模型，让其按步骤调用工具。

### C01 [P0]：连接与工具/资源发现（Smoke）

**目的**：验证 MCP 握手成功；工具、resources 可列出。

**步骤（概念）**

1. Client 连接 MCP server（stdio）
2. 执行 `tools/list`，应看到 4 个工具：
   - `claude_code`
   - `claude_code_reply`
   - `claude_code_check`
   - `claude_code_session`
3. 执行 `resources/list`，应看到：
   - `claude-code-mcp:///server-info`
   - `claude-code-mcp:///internal-tools`
   - `claude-code-mcp:///gotchas`

**预期**

- 能列出上述条目；无握手错误；stdio 模式下 server 不应在 stdout 输出非 MCP 数据（本项目日志走 stderr / MCP logging）。

### C02 [P1]：读取内置资源（server-info / gotchas / internal-tools）

**目的**：验证 resources/read 可用，且 tool catalog 可读。

**步骤**

1. `resources/read` 读取 `claude-code-mcp:///server-info`
2. `resources/read` 读取 `claude-code-mcp:///gotchas`
3. `resources/read` 读取 `claude-code-mcp:///internal-tools`

**预期**

- `server-info` 返回 JSON，包含 `node/platform/arch` 等
- `gotchas` 返回 markdown 文本
- `internal-tools` 返回 JSON，包含 `tools[]`，至少包含：`Bash/Read/Write/Edit/Grep/Glob/Task` 等

### C03 [P0]：启动会话 → 轮询 → 得到结果（核心闭环）

**目的**：验证 `claude_code` 异步启动 + `claude_code_check poll` 轮询能走到终态。

**建议输入（claude_code）**

- `cwd` 指向你的 E2E 沙盒项目目录
- `maxTurns=6`
- `advanced.maxBudgetUsd=0.2`
- `allowedTools=[]`（先不预批，便于后续权限用例复用）

**prompt 示例**

> 在当前目录创建文件 `mcp_smoke.txt`，写入 `ok`，然后用 bash 输出该文件内容，最后总结你做了什么。

**预期**

- `claude_code` 返回 `{ sessionId, status:"running", pollInterval }`
- `claude_code_check (poll)`：
  - session 可能进入 `waiting_permission`
  - `events[]` 会出现 `output/progress/permission_request`
  - 终态时 `status` 为 `idle` 或 `error`，并包含 `result`（或 events 中出现 `result/error`）
- 建议增加“可验证断言”（由测试执行方在本机文件系统侧验证）：
  - 断言 `mcp_smoke.txt` 存在且内容为 `ok`
  - 断言 `result.sessionId===sessionId` 且 `result.totalCostUsd>=0`、`result.numTurns>=1`

### C04 [P1]：轮询游标与分页（cursor/nextCursor/cursorResetTo）

**目的**：验证事件流可增量读取，避免重复拉取。

**步骤**

1. 首次 poll 不带 cursor，记录返回的 `nextCursor`
2. 第二次 poll 带上 `cursor=<上次 nextCursor>`，应只返回增量 events
3. 将 `maxEvents` 设置为较小值（例如 5），验证分页：多次 poll 才能读完整事件

**预期**

- `nextCursor` 单调递增
- 若事件缓冲发生裁剪，可能出现 `cursorResetTo`（表示传入 cursor 太旧）

### C05 [P2]：includeTools 工具发现（runtime init tools）

**目的**：验证 `claude_code_check` 的 `includeTools=true` 可返回 `availableTools`。

**步骤**

1. 对一个已启动并收到过 `system/init` 的 session 执行：
   - `claude_code_check`（poll）并设置 `pollOptions.includeTools=true`

**预期**

- 返回 `availableTools[]`，包含 `Bash/Read/Write/Edit/...`（以 SDK init 工具列表为准）

### C06 [P0]：`maxTurns` 耗尽（失控防护）

**目的**：验证达到 `maxTurns` 上限后 session 可正确终止且可观测。

**步骤**

1. 启动新 session：`maxTurns=1`（或 2），prompt 要求多步操作（例如“创建文件、再运行测试、再总结”）
2. `claude_code_check poll` 直到终态

**预期**

- `result.isError=true`
- `result.errorSubtype` 包含 `error_max_turns`（或结果文本包含 max turns 相关提示）
- session 不应无限卡住在 `running/waiting_permission`

### C07 [P0]：`advanced.maxBudgetUsd` 耗尽（失控防护）

**目的**：验证费用上限能阻止 runaway。

**步骤**

1. 启动新 session：`advanced.maxBudgetUsd=0.01`（尽量小），prompt 要求执行较多步骤（例如跑测试+修复+再跑）
2. `claude_code_check poll` 直到终态

**预期**

- `result.isError=true`
- `result.errorSubtype` 包含 `error_max_budget_usd`（或结果文本包含预算超限）

### C08 [P1]：`responseMode="minimal"` vs `"full"`（载荷与字段）

**目的**：验证 minimal 模式下 payload 精简、字段裁剪符合预期。

**步骤**

1. 对同一个 session：
   - `claude_code_check poll`（`responseMode="minimal"`）
   - `claude_code_check poll`（`responseMode="full"`）

**预期**

- minimal 模式：默认不返回 `usage/modelUsage/structuredOutput`，且 `output` 事件的 message 字段被瘦身（仅保留必要字段）
- full 模式：可返回更完整字段（例如 `lastEventId/lastToolUseId`，以及在需要时包含 `usage/modelUsage/structuredOutput`）

### C11 [P2]：structuredOutput（JSON Schema 输出）

**目的**：验证 `advanced.outputFormat` + `includeStructuredOutput` 的闭环。

**步骤**

1. `claude_code` 设置：
   - `advanced.outputFormat={ type:"json_schema", schema:{...} }`
2. prompt 要求按 schema 输出结构化结果
3. `claude_code_check poll` 使用 `responseMode="full"` 并启用 `includeStructuredOutput=true`

**预期**

- `result.structuredOutput` 存在且满足 schema 约束（至少字段类型与必填项符合）

### C12 [P1]：非法参数校验（负向用例）

**目的**：验证工具入参校验与错误码稳定。

**建议覆盖**

- `claude_code`：空 `cwd`、空 `prompt`、`maxTurns<=0`
- `claude_code_check`：空 `sessionId`、`respond_permission` 缺失 `requestId/decision`
- `claude_code_reply`：空 `sessionId`、对 `cancelled` session reply

**预期**

- 返回 `Error [INVALID_ARGUMENT]` / `Error [SESSION_NOT_FOUND]` / `Error [CANCELLED]` 等明确错误，不应崩溃

---

## 5. 权限相关用例（必须覆盖）

> 说明：`allowedTools` 自动批准；`disallowedTools` 永久拒绝；其余工具会触发 `waiting_permission` 并在 `actions[]` 暴露请求。

### P01 [P0]：触发 permission_request → allow → 继续运行

**步骤**

1. 用例 C03 的 prompt 通常会触发 `Write` / `Bash` 等权限请求
2. 轮询到 `status=waiting_permission` 后，拿到 `actions[].requestId`
3. 调用 `claude_code_check`：
   - `action="respond_permission"`
   - `decision="allow"`

**预期**

- `events` 中出现 `permission_result`
- session 回到 `running`，继续推进直至终态

### P02 [P0]：deny + interrupt=false（不中断，只拒绝该工具调用）

**步骤**

1. 在 `waiting_permission` 时对某个 requestId：
   - `decision="deny"`
   - `interrupt=false`
2. 继续轮询

**预期**

- `permission_result` 记录 deny
- session 可能继续运行（模型会改用替代方案或结束），最终结果中可能出现 `permissionDenials`

### P03 [P1]：deny + interrupt=true（拒绝并中断）

**步骤**

1. 在 `waiting_permission` 时：
   - `decision="deny"`
   - `interrupt=true`
2. 继续轮询

**预期**

- session 很快进入 `error` 或 `cancelled`（取决于 SDK 行为与错误分类）
- `result.isError=true`，`result.result` 包含取消/拒绝相关信息

### P04 [P2]：updatedInput（允许但修改工具输入）

**目的**：验证“批准前改写工具输入”闭环可用（高风险但很实用）。

**步骤**

1. 等待一个 `Bash` 权限请求
2. `respond_permission` 时：
   - `decision="allow"`
   - `permissionOptions.updatedInput` 填入一个更安全的命令（例如把 `rm -rf` 改成 `ls`）

**预期**

- 后续 `output/progress` 体现实际执行的是更新后的输入（具体表现因 SDK 事件内容而异）

### P05 [P0]：allowedTools / disallowedTools 行为

**步骤**

1. 启动新 session，设置：
   - `allowedTools=["Read","Grep"]`
   - `disallowedTools=["Bash"]`
2. prompt 指示：读文件 + grep + 运行命令

**预期**

- `Read/Grep` 不应触发权限请求（或显著减少请求）
- `Bash` 应被硬拒绝（通常不会进入可批准状态；最终结果可能出现 `permissionDenials`）

### P06 [P1]：权限超时自动 deny（回归用）

**步骤**

1. 将 `permissionRequestTimeoutMs` 设为很小（例如 3000ms）
2. 触发 permission_request 后不做 respond

**预期**

- 超时后该请求自动 deny（`actions[].expiresAt/remainingMs` 可观测）
- session 继续运行或进入终态；不会无限卡住

### P07 [P2]：`disallowedTools` 中包含未知工具名（健壮性）

**目的**：验证未知工具名不会导致崩溃/不可预期行为。

**步骤**

1. 启动 session：`disallowedTools=["THIS_TOOL_DOES_NOT_EXIST"]`
2. prompt 执行正常任务（例如创建文件、读写、运行测试）

**预期**

- session 能正常运行；未知工具名要么被忽略，要么体现在最终结果的拒绝/诊断信息中（以 SDK 行为为准），但不应导致 server 抛异常

---

## 6. 会话管理用例（必须覆盖）

### S01 [P0]：list / get（含 includeSensitive）

**步骤**

1. 启动至少 1 个 session 后：
   - `claude_code_session action="list"`
2. 对其中一个 session：
   - `action="get"`（`includeSensitive=false` 与 `true` 都测）

**预期**

- `list` 返回 redacted 的 `PublicSessionInfo[]`
- `get(includeSensitive=true)` 返回包含 `cwd/systemPrompt/agents`（但仍不返回 `env`）
- 建议增加断言：
  - `get(includeSensitive=false)` 的返回不应包含 `cwd/systemPrompt/agents`

### S02 [P0]：cancel（running / waiting_permission）

**步骤**

1. 启动一个会触发较多动作的 session（例如要求运行测试、修改多文件）
2. 在 `running` 或 `waiting_permission` 时执行：
   - `claude_code_session action="cancel"`
3. 再 `claude_code_check poll`

**预期**

- session 进入 `cancelled`
- 返回 `cancelledAt/cancelledReason/cancelledSource`
- 之后 `claude_code_reply` 对该 session 应失败（提示 cancelled 不可 resume）

### S03 [P1]：claude_code_reply（继续会话）与 forkSession

**步骤**

1. 对一个 `idle` 或 `error` 的 session，执行 `claude_code_reply`（同目录继续任务）
2. 另起一次 reply，设置 `forkSession=true`

**预期**

- 普通 reply 复用原 `sessionId`
- fork reply 返回新 `sessionId`（且不影响原 session 的累计 turns/cost）

### S04 [P1]：并发多 session 隔离（不会串事件/权限）

**目的**：验证并发情况下事件、actions、结果不会串到别的 sessionId。

**步骤**

1. 同时启动 2 个 session（不同 cwd 或不同 prompt）
2. 并发轮询两个 session：分别维护自己的 `cursor/nextCursor`

**预期**

- `events[].data` 的 `sessionId`（若出现）与当前轮询 session 一致
- `actions[]` 只出现在对应的 `sessionId` 上
- `claude_code_session list` 返回两个 session

### S05 [P1]：无效/过期 sessionId（负向）

**目的**：验证 `SESSION_NOT_FOUND` 等错误码稳定。

**步骤**

1. 对随机 `sessionId` 调：
   - `claude_code_check poll`
   - `claude_code_reply`
   - `claude_code_session cancel`

**预期**

- 返回 `Error [SESSION_NOT_FOUND]`（或明确的 invalid argument），不应崩溃

### S06 [P1]：对 `running` session 执行 reply（应拒绝）

**目的**：避免同一 session 并发 resume 导致状态错乱。

**步骤**

1. 启动 session 后立即对同一 `sessionId` 调 `claude_code_reply`

**预期**

- 返回 `Error [SESSION_BUSY]`（或提示 status=running 不可用）

---

## 7. disk-resume 回归用例（高级但建议覆盖）[P2]

> 适用场景：MCP server 重启 / session 过期被清理，但 Claude Code 的 transcript 仍在磁盘；希望通过 `claude_code_reply` 恢复继续。

### 7.1 配置开关

在启动 MCP server 的环境里设置：

- `CLAUDE_CODE_MCP_ALLOW_DISK_RESUME=1`
- `CLAUDE_CODE_MCP_RESUME_SECRET=<强随机字符串>`（用于生成/校验 resumeToken）

### 7.2 用例：重启后继续

**步骤**

1. 用 `claude_code` 启动一个 session，记录：
   - `sessionId`
   - 返回的 `resumeToken`（仅当设置了 `CLAUDE_CODE_MCP_RESUME_SECRET` 才会返回）
2. 重启 MCP server（确保内存 session 消失）
3. 调用 `claude_code_reply`，携带 `diskResumeConfig`：
   - `resumeToken=<上一步 token>`
   - `cwd=<原工作目录>`（必填）
   - 其余参数按需覆盖（allowedTools/disallowedTools/tools/maxTurns/...）

**预期**

- 若 token 有效且 transcript 存在，reply 应成功返回 `status:"running"`
- token 缺失/无效应返回 `Error [PERMISSION_DENIED]`

---

## 8. 真实编程任务用例（必须覆盖至少 1 个）

建议所有“真实编程任务”都在第 3 节的独立沙盒中完成，并且每个任务都有明确的本地验收命令。

### T01 [P0]：Bug Fix（单测驱动）

**准备**

- 沙盒项目存在 1 个失败测试（例如 `node-vitest-bug`）

**给模型的任务描述（可直接粘贴）**

> 目标：让 `npm test` 通过。请先运行测试复现失败，再定位根因并做最小修复，最后再次运行测试确认通过。修改必须包含：代码修复 + 必要时补充/调整测试。不要做无关重构。

**预期**

- 产出一个最小 diff
- `npm test` 通过
- `claude_code_check` 最终 `result.isError=false`

### T02 [P1]：Feature（新增功能 + 测试）

**示例**

- 新增一个 CLI 参数（例如 `--json` 输出）
- 要求补测试，并提供命令行演示

**预期**

- 功能按描述实现
- 测试通过

### T03 [P2]：Refactor（不改行为）

**示例**

- 将一段逻辑拆分为 2～3 个小函数/模块
- 明确要求“不改变行为”，并在任务前后运行测试

**预期**

- 测试全通过，行为一致

### T04 [P2]：子 agent（advanced.agents + Task 权限）

**目的**：覆盖“多智能体”与权限联动（必须允许 `Task`）。

**做法**

1. `claude_code` 的 `advanced.agents` 定义一个子 agent（例如专门跑测试/分析日志）
2. 将 `allowedTools` 加入 `Task`（否则子 agent 无法启动）
3. prompt 指示主 agent “把日志分析交给子 agent”

**预期**

- 轮询中能看到与子 agent 相关的 `output/progress`
- 任务成功完成；若未允许 `Task`，应能看到清晰的权限阻断现象（用于验证防护有效）

---

## 9. 常见故障排查（建议直接复制到回归文档末尾）

- **Windows 找不到 Git Bash**：设置 `CLAUDE_CODE_GIT_BASH_PATH`，重启 Client/Server
- **一直卡在 waiting_permission**：检查是否漏掉 `respond_permission`；或 `permissionRequestTimeoutMs` 太大导致等待过久；可在 actions 里看 `expiresAt/remainingMs`
- **SESSION_NOT_FOUND**：说明内存 session 已清理/服务重启；如需继续，按第 7 节启用 disk-resume
- **事件太多/载荷过大**：用 `responseMode="minimal"`、合理使用 `cursor/maxEvents`；仅在需要时 `includeUsage/includeModelUsage/includeStructuredOutput`
- **工具名不匹配**：以 `claude_code_check includeTools=true` 返回的 `availableTools[]` 为准（常见：`Bash/Read/Write/Edit/Grep/Glob/Task/...`）
- **启动超时（Error [TIMEOUT]: session init timed out）**：将 `advanced.sessionInitTimeoutMs` 调大（例如 60000ms），尤其在 Windows 或冷启动时更常见

---

## 10. 自动化回归执行（建议）

本节目标：把上面的“手工 E2E 用例”中 P0/P1 的关键路径做成脚本化回归，便于长期维护。

### 10.1 推荐落地路径（最少阻力）

1. 用 Node 写一个轻量 test runner（建议 Vitest / Node test runner 均可）
2. 使用 `@modelcontextprotocol/sdk` 的 **client transport** 连接本 MCP server：
   - 首选 stdio：启动 `npx -y @leo000001/claude-code-mcp` 子进程并连接（最简单、跨平台）
   - 可选 HTTP：仅在你的 server 构建支持 HTTP transport 时启用，用 `StreamableHTTPClientTransport` 连接 `http://127.0.0.1:<port>/mcp`（当前主分支默认 stdio）
3. 以“工具调用”作为断言边界：tools/list、resources/read、claude_code/claude_code_check/claude_code_session

本仓库已内置一个最小可运行的自动化骨架（默认只跑离线 smoke；在线真实编程任务需显式开启）：

```bash
npm run e2e
```

可选开关：

- 仅在你希望验证“已发布包（第三方安装）”时设置：`CLAUDE_CODE_MCP_E2E_USE_NPX=1`
- 启用 HTTP transport smoke（默认关闭）：`CLAUDE_CODE_MCP_E2E_HTTP=1`
- 开启在线真实编程任务（需要本机 Claude Code 配置已就绪）：`CLAUDE_CODE_MCP_E2E_ONLINE=1`

### 10.2 建议的自动化组件（抽象）

- `connect()`：建立 MCP 连接（stdio 或 http）
- `callTool(name, args)`：封装 `tools/call`
- `pollUntilTerminal(sessionId)`：
  - 维护 `cursor/nextCursor`
  - 累积 `events[]`
  - 遇到 `status=waiting_permission` 时按策略自动 allow/deny（或将 requestId 交给测试用例决定）
- `teardown()`：
  - 对仍在 running/waiting 的 session 调 `claude_code_session cancel`

### 10.3 自动化断言建议（跨用例复用）

- **cursor 连续性**：`nextCursor` 单调递增；若出现 `cursorResetTo`，记录并将 cursor 重置到该值
- **事件序列**：允许存在 `output/progress` 交错；关键是：
  - 有权限时：`permission_request` 必须能被 `respond_permission` 终结并出现 `permission_result`
  - 终态时：`result` 字段存在（或 events 中含 `result/error`）
- **权限超时**：对 P06，断言在 `permissionRequestTimeoutMs` 附近出现 auto-deny（并且不会永久卡住）
- **容量与隔离**：并发 session 时 actions/events 不串
