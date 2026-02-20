# claude-code-mcp 第三方 CLI 大模型 E2E 执行手册

本手册只面向一种场景：第三方 CLI 客户端已经接入并启用了本 MCP server（`@leo000001/claude-code-mcp`），你需要指导该客户端中的大模型正确使用并测试本 MCP。

你应优先通过 MCP 工具调用验证事实，不要根据推测给出测试结论。

本 MCP 固定提供 4 个工具：

- `claude_code`
- `claude_code_reply`
- `claude_code_check`
- `claude_code_session`

会话状态机：`running -> idle | error | cancelled`，中途可能经过 `waiting_permission`（`running <-> waiting_permission`）。

---

## 1. 执行目标

你的目标不是“写计划”，而是完成一次可验证的端到端测试闭环，并输出结构化报告。

最低通过标准（必须全部满足）：

1. 能发现 4 个工具，并至少读取 1 个内置 resource。
2. 能完成 1 次完整生命周期：`claude_code -> claude_code_check(poll) -> 终态(result)`。
3. 能至少处理 1 次权限请求（`respond_permission` 的 allow/deny/allow_for_session）。
4. 能完成 1 个真实编程任务验收（本地测试命令先失败、修改后通过）。
5. 能显式完成 1 次 `claude_code_reply` 调用并返回可解析结果（成功或失败都需可解释）。
   - `claude_code_reply` 仅在会话处于 `idle` 或 `error` 状态时可调用；对 `running` / `waiting_permission` 状态的会话调用会返回 `SESSION_BUSY`（属于可解释失败）。
   - 建议在用例 B 或 E 的会话到达终态后，再对同一 `sessionId` 调用 `claude_code_reply` 发送追问。
6. 结束时清理残留会话（取消所有 `running/waiting_permission`）。

兼容性说明（必须知晓）：

- 当前 backend 不支持 `respond_user_input`，测试时只走 `respond_permission` 流程。

---

## 2. 执行前自检（不做安装教学）

只检查，不安装。

1. 当前客户端已连接本 MCP server，且可调用 MCP tools。
2. 运行环境有可用 Node.js（`>=18`）。
3. 目标 `cwd` 必须存在且可访问（尤其是传给 `claude_code.cwd` 或 `diskResumeConfig.cwd` 的目录）。
4. 本机 Claude 本地配置可用（默认读取 `user/project/local` setting sources）。
5. Windows 场景可用 Git Bash；若自动检测失败，设置：
   - `CLAUDE_CODE_GIT_BASH_PATH=<你的 bash.exe 路径>`
6. 为防跑飞，建议每次 `claude_code` 使用：
   - `maxTurns: 6-12`
   - `advanced.maxBudgetUsd: 0.2-1.0`
   - `advanced.sessionInitTimeoutMs: 10000-20000`
7. 权限循环准备：
   - 明确如何记录 `requestId` 与预期决策（allow/deny/allow_for_session）。
   - 明确权限请求默认超时 `permissionRequestTimeoutMs=60000`，到期会自动 deny。

---

## 3. 关键点先对齐（可和 `claude_code` 讨论）

在以下关键节点，建议先让模型用一句话确认目标，再执行调用：

1. 第一次看到 `waiting_permission` 时：先确认“本次应 allow、allow_for_session 还是 deny”。
2. 第一次出现 `error` 终态时：先确认“是参数问题、权限问题，还是任务本身失败”。
3. 真实编程任务开始前：先确认“最小修复范围”与“验收命令”。
4. 结束清理前：先确认“是否还有 running/waiting session 未处理”。

可直接用的讨论模板：

```text
请先简要确认本步的目标、成功条件和最小动作，然后再执行工具调用。
如果有多种路径，先给推荐路径，再执行推荐路径。
```

---

## 4. 标准执行循环（通用）

按这个固定循环执行，不要跳步。

1. 调 `claude_code` 启动 session，记录 `sessionId`。
2. 用 `claude_code_check` action=`poll` 轮询。
3. 若状态是 `waiting_permission`，处理 `actions[]`：
   - 从 `actions[]` 读取 `requestId`。
   - 调 `claude_code_check` action=`respond_permission`，必须同时传 `requestId` 和 `decision`（`allow` / `deny` / `allow_for_session`）。
4. 重复轮询直到终态：`idle | error | cancelled`。
5. 读取并记录 `result`。
6. 在结束阶段调用 `claude_code_session cancel` 清理残留运行会话。

轮询规则（强制）：

- 首次 poll 不带 `cursor`。
- 后续 poll 始终带上上次返回的 `nextCursor`。
- 如果返回 `cursorResetTo`，立即重置本地 cursor 并继续。
- 如果某轮未返回 `nextCursor`，用上次成功 cursor 重试 1 次并写入日志。
- 如果出现 `nextCursor` 不变且 `events` 为空，允许按同一 cursor 重试最多 3 次；超过上限再标记 `poll_stall_suspected`。
- 如果 `status=waiting_permission`，必须处理 `actions[]`，禁止无限 poll。
- Windows 下记录 `posix_path_incidents`（出现 `/home/...` 或其他明显 POSIX 绝对路径的次数）；建议阈值为 0，超过阈值记为质量不达标。
- Windows 路径强制校验（仅 `process.platform === 'win32'`）：
  - 校验对象是 `actions[]` 中 `permission_request` 的最终执行参数（如 `input.file_path`、`input.command`），而非 `events` 中模型生成的 `tool_use` 文本。因为 server 或 SDK 可能已将路径规范化为 Windows 格式，仅凭 `tool_use` 文本判断会产生误杀。
  - 若 `permission_request` 的最终执行参数仍包含 `/home/`、`/d/`、`/c/` 等 POSIX 风格路径，对该请求执行 `deny`，并在后续 `claude_code_reply` 或新 session 的 prompt 中追加纠偏指令：`"你刚才使用了 POSIX 风格路径 {path}，请改写为 Windows 绝对路径（如 D:\\...）后重试。"`
  - 若工具已被 `allowedTools` 自动批准（无 `permission_request` 可拦截），则在最终报告中记录 `posix_path_incidents++` 并标记为质量不达标。
  - 若 `tool_use` 文本为 POSIX 但 `permission_request.input` 已被规范化为 Windows 路径，不计为 incident，仅记录为 `posix_normalized_count`（信息性指标，不影响判定）。

关键观测字段（每轮都要记录）：

- `status`
- `events`
- `actions`
- `result`
- `nextCursor`
- `cursorResetTo`
- `truncated`
- `toolValidation`
- `compatWarnings`

---

## 5. 必跑用例（通用主流程）

下面每个用例都包含：目标、指令模板、通过判据、失败恢复。

### 5.1 用例 A：连接与发现（Smoke）

目标：确认 MCP 握手可用，工具和资源可发现。

给模型的指令模板：

```text
请先通过客户端工具注册表或可调用性确认 4 个工具：claude_code、claude_code_reply、claude_code_check、claude_code_session。
（可选）如果客户端支持 tools/list 协议方法，可调用 tools/list 做二次确认；不支持时跳过此步，不影响判定。
然后调用 resources/list，并至少读取一个资源（建议 claude-code-mcp:///server-info、claude-code-mcp:///quickstart、claude-code-mcp:///errors 和 claude-code-mcp:///compat-report）。
请输出你读到的关键字段。
```

通过判据：

1. 能确认 4 个工具都可调用（可通过客户端工具注册表、直接调用、或 tools/list；tools/list 为可选增强，不支持不扣分）。
2. `resources/read` 成功返回内容。

失败恢复：

1. 如果 tools 缺失，检查客户端 MCP server 是否连到正确配置。
2. 如果 resources/read 失败，记录错误并继续后续用例，但最终报告标记为 failed。

### 5.2 用例 B：启动会话并轮询到终态

目标：验证 `claude_code` 异步启动和 `claude_code_check` 轮询闭环。

建议调用参数：

- `cwd`: 指向独立测试工作目录
- `maxTurns`: `6`
- `advanced.maxBudgetUsd`: `0.2`
- `advanced.sessionInitTimeoutMs`: `15000`（`claude_code` 的推荐写法）
- `allowedTools`: `["Read", "Write"]`
- `strictAllowedTools`: `true`（建议开启，确保 `allowedTools` 是严格白名单语义；该参数在 `claude_code` 和 `diskResumeConfig` 中均可用，部分客户端可能不在 UI 中展示但实际可传递）
  - 注意：`strictAllowedTools` 保证执行层拦截（未授权工具的 `tool_use` 会被 server 拒绝），但不保证模型不会先生成未授权工具的调用计划。评估时应以 `permission_result` / 实际执行结果为准，而非模型输出的 `tool_use` 文本。
- `disallowedTools`: 仅当通过 `includeTools=true` 确认 Bash 在运行时工具列表中时才设置为 `["Bash"]`；否则省略该字段（避免 `Unknown disallowedTools: Bash` 告警）
- 即使 prompt 中明确要求“不要调用 Bash”，也应以策略约束（`strictAllowedTools` / `allowedTools` / `disallowedTools`）作为主判据（smoke 仅验证基础读写闭环；权限闭环由用例 C 覆盖）

给模型的任务 prompt 示例：

```text
在当前目录创建 mcp_smoke.txt，写入 ok；然后读取并输出该文件内容；最后总结执行步骤。
Windows 场景重要约束：若你生成的路径包含 /home/ 或其他 POSIX 风格路径，必须先自检并改写为当前 cwd 下的 Windows 绝对路径后再执行。
```

通过判据：

1. `claude_code` 返回 `sessionId` 且 `status=running`。
2. 轮询最终进入 `idle` 或 `error` 或 `cancelled`。
3. 终态有 `result`（成功或失败均需有可解释结果）；若失败，记录 `result.errorSubtype`。
4. 成功路径下，文件 `mcp_smoke.txt` 存在且内容为 `ok`。

失败恢复：

1. 若长期停在 `running`，检查是否遗漏 cursor 更新。
2. 若停在 `waiting_permission`，立即处理 `actions[]`。
3. 若 `error`，记录 `result.errorSubtype` 和关键 event。
4. 若出现 `Unknown disallowedTools` 告警，建议移除未知工具名以消除告警；仅在闭环失败时判定为 failed。

### 5.3 用例 C：权限闭环（allow / allow_for_session / deny）

目标：验证异步权限裁决通路。

步骤要求：

1. 启动一个会触发工具调用的任务（例如写文件 + 执行命令），且不要预批准相关工具（如 `allowedTools` 不包含 `Write/Bash`）。
2. poll 到 `waiting_permission` 后读取 `actions[].requestId`。
3. 若有多个 request，同时记录每个 `requestId -> 期望决策`，按顺序逐个处理。
4. 对其中一个 request 做 allow 或 allow_for_session。
5. 再对另一个 request 做 deny（可选 `interrupt=true` 或 `interrupt=false`）。
6. 若同一 session 内因 `allow_for_session` 不再出现后续请求，允许在第二个 session 中完成 deny 分支验证。

给模型的指令模板：

```text
当 session 进入 waiting_permission 时，不要继续空轮询。
请读取 actions[]，对第一个 requestId 执行 allow_for_session（或 allow）。
如果出现第二个 requestId，再执行 deny（interrupt=false）。
每次 respond_permission 后，请确认 events 里出现 permission_result。
如果请求快过期（默认 60000ms），优先处理剩余时间最短的 requestId。
在 Windows 上，优先使用当前 cwd 下的绝对 Windows 路径（如 `C:\\repo\\...`），避免使用 `/home/user/...`。
随后继续 poll 到终态，并汇报 permission_result 事件。
```

通过判据：

1. 出现 `permission_request`。
2. `respond_permission` 后出现 `permission_result`，且 `behavior` 与预期方向一致（allow/deny）。
3. 状态可从 `waiting_permission` 回到 `running` 或进入终态。
4. 若使用 `allow_for_session`，后续同工具调用可被会话级自动批准（不再重复弹权限）；但若该工具在 `disallowedTools` 中，仍应被拒绝。

失败恢复：

1. 若 request 过期，记录 `expiresAt/remainingMs`，重新触发权限场景。
2. 若一直无权限请求，检查是否设置了过宽 `allowedTools` 导致自动批准。
3. 若出现并发请求漏处理，先回到 `actions[]` 建立 `requestId -> 决策` 清单，再继续。
4. 若 `allow_for_session` 后仍收到 deny，优先检查 `disallowedTools` 是否包含该工具（包含时 deny 为预期行为）。

### 5.4 用例 D：会话管理（list/get/cancel/interrupt）

目标：验证会话管理工具行为稳定。

给模型的指令模板：

```text
请调用 claude_code_session action=list，列出当前 sessions。
对一个 session 调用 action=get（分别测试 includeSensitive=false 和 true）。
再选择一个 running 或 waiting_permission 的 session 调用 action=interrupt，确认它不是直接 cancelled。
最后选择一个 running 或 waiting_permission 的 session 调用 action=cancel，再 poll 验证状态变为 cancelled。
不要对已终态 session 重复 cancel。
```

通过判据：

1. `list` 返回会话列表。
2. `get(includeSensitive=false)` 不泄露敏感字段。
3. `get(includeSensitive=true)` 对已设置字段可见；未设置字段可不存在（仍不应暴露 `env/mcpServers/sandbox` 等敏感内容）。
4. `interrupt` 与 `cancel` 语义分离：interrupt 不应像 cancel 一样直接将 session 置为 cancelled；但 interrupt 可能导致 SDK 以 error 状态结束（含 CANCELLED result），客户端需兼容处理这两种情况。
5. `cancel` 后状态进入 `cancelled`。

失败恢复：

1. 若 `SESSION_NOT_FOUND`，核对 sessionId 是否来自当前连接上下文。
2. 若 cancel 后仍 `running`，短轮询并记录取消相关字段后再判断。

### 5.5 用例 E：真实编程任务验收（必跑）

目标：验证该 MCP 在真实 coding task 中可用，而不仅是协议层可用。

准备要求：

1. 使用独立测试项目目录（不要污染本仓库主目录）。
2. 项目中存在可复现失败测试。可使用本仓库提供的内置 fixture 快速初始化：

Bash / Git Bash：

```bash
# 在测试工作目录下执行（如 D:\Lab\Test-Claude-Code-MCP\e2e_real_task）
mkdir -p e2e_real_task && cd e2e_real_task
cat > package.json << 'PKGJSON'
{
  "name": "e2e-real-task",
  "version": "1.0.0",
  "scripts": { "test": "node test.js" }
}
PKGJSON
cat > sum.js << 'SUMJS'
function sum(a, b) {
  return a - b; // BUG: should be a + b
}
module.exports = sum;
SUMJS
cat > test.js << 'TESTJS'
const sum = require("./sum");
const assert = require("assert");
assert.strictEqual(sum(1, 2), 3, "1 + 2 should equal 3");
assert.strictEqual(sum(-1, 1), 0, "-1 + 1 should equal 0");
assert.strictEqual(sum(0, 0), 0, "0 + 0 should equal 0");
console.log("All tests passed");
TESTJS
```

PowerShell（Windows 原生终端）：

```powershell
# 在测试工作目录下执行（如 D:\Lab\Test-Claude-Code-MCP\e2e_real_task）
New-Item -ItemType Directory -Force -Path e2e_real_task | Out-Null
Set-Location e2e_real_task

@'
{
  "name": "e2e-real-task",
  "version": "1.0.0",
  "scripts": { "test": "node test.js" }
}
'@ | Set-Content -Encoding UTF8 package.json

@'
function sum(a, b) {
  return a - b; // BUG: should be a + b
}
module.exports = sum;
'@ | Set-Content -Encoding UTF8 sum.js

@'
const sum = require("./sum");
const assert = require("assert");
assert.strictEqual(sum(1, 2), 3, "1 + 2 should equal 3");
assert.strictEqual(sum(-1, 1), 0, "-1 + 1 should equal 0");
assert.strictEqual(sum(0, 0), 0, "0 + 0 should equal 0");
console.log("All tests passed");
'@ | Set-Content -Encoding UTF8 test.js
```

上述 fixture 的预期行为：`npm test` 首次运行失败（`sum` 函数用了 `-` 而非 `+`），模型需将 `return a - b` 改为 `return a + b`，再次运行测试通过。

如果不使用内置 fixture，也可自行准备满足"可复现失败"条件的项目，但必须在报告中说明项目来源。

给模型的任务模板：

```text
目标：让本目录测试命令通过。
先运行测试复现失败；再定位根因并做最小修复；最后再次运行测试确认通过。
Windows 场景重要约束：若你生成的路径包含 /home/ 或其他 POSIX 风格路径，必须先自检并改写为当前 cwd 下的 Windows 绝对路径后再执行。
不要做无关重构。
输出：失败原因、修改点、复测结果。
```

通过判据：

1. 初次测试失败被复现。
2. 修改后测试命令退出码为 0。
3. `result.isError=false`。
4. 变更是最小必要改动。
5. （推荐）在真实仓库子目录再执行 1 次最小修复闭环，避免仅玩具项目通过。此项为推荐而非必跑，未执行不影响最低通过判定，但建议在报告中注明是否执行。

失败恢复：

1. 如果模型跳过复现，要求其重新执行“先复现再修复”。
2. 如果修复后仍失败，要求其给出下一轮最小变更并再执行一轮。

---

## 6. 强制清理步骤（每轮测试结束）

给模型的指令模板：

```text
请先调用 claude_code_session action=list。
对所有 status 为 running 或 waiting_permission 的 session，逐个调用 action=cancel。
然后对每个被取消 session 再做一次 poll，确认终态。
最后再调用一次 claude_code_session action=list，确认已无 running/waiting_permission。
如果过程中出现 Transport closed，请先重连 MCP server，再继续执行 list/cancel/poll 清理。
```

通过判据：

1. 不存在残留 `running/waiting_permission` 会话。
2. 已取消会话在后续 poll 中可见 `cancelled` 状态。
3. 二次 `list` 校验通过（无遗漏会话）。

---

## 7. 结果报告模板（通用）

测试结束后，模型必须输出结构化结果。

### 7.1 Markdown 模板

```markdown
# MCP E2E Test Report
- test_start_time:
- test_end_time:
- environment:
- sessions:
- passed_cases:
- failed_cases:
- key_errors:
- final_verdict:
```

### 7.2 JSON 模板

```json
{
  "test_start_time": "",
  "test_end_time": "",
  "environment": {
    "platform": "",
    "client": "",
    "cwd": ""
  },
  "session_ids": [],
  "passed_cases": [],
  "failed_cases": [],
  "key_errors": [],
  "final_verdict": "pass|fail"
}
```

---

## 8. 常见失败与恢复动作

1. Windows 报 Git Bash 相关错误。
   - 设置 `CLAUDE_CODE_GIT_BASH_PATH` 后重启客户端。
2. 长时间 `waiting_permission`。
   - 检查是否未调用 `respond_permission`。
   - 检查 `permissionRequestTimeoutMs` 是否过大（默认 `60000`）。
3. `SESSION_NOT_FOUND`。
   - session 可能已失效或 server 已重启，需要重新启动会话。
4. 事件读取混乱或重复。
   - 严格按 `nextCursor` 递增；遇 `cursorResetTo` 立即重置。
5. 结果缺少关键信息。
   - 用 `claude_code_check` 的 `responseMode=full` 再读取终态信息。
6. 出现 `Transport closed`。
   - 先重连 MCP server，再优先执行 `claude_code_session(action=list)`。
   - 对 `running/waiting_permission` 会话继续做 `cancel + poll` 清理。
   - 在报告中记录 `transport_health` 与是否完成重连后的清理验收。
7. `claude_code_reply` 返回 `SESSION_BUSY`。
   - 说明会话仍在 `running` 或 `waiting_permission` 状态，不可接受新 prompt。
   - 先等待会话到达终态（`idle` / `error` / `cancelled`），再调用 `claude_code_reply`。
   - 若需要中断当前执行，先调用 `claude_code_session(action=interrupt)` 或 `cancel`，等终态后再 reply。

---

## 9. 可选增强测试（非必跑）

当必跑项通过后，可按需追加：

1. `claude_code_reply(forkSession=true)`：验证分支会话返回新 `sessionId`，且与原会话事件流独立。
2. `maxTurns`/`advanced.maxBudgetUsd`：验证失控防护。
3. `includeTools=true`：验证运行时工具发现列表。
4. `structuredOutput`：验证 schema 约束输出。
5. `disk resume`：在启用环境变量时验证重启后的恢复能力。

---

## Appendix A：Codex CLI 手动测试附录

本附录专门强调：在 Codex CLI 中，如何手动驱动该 MCP 完成测试。

### A.1 适用前提

1. Codex CLI 已接入 `claude-code-mcp` server。
2. 当前会话可调用 MCP 工具。
3. 你只做手动对话式测试，不做脚本化回归。

如果尚未接入，可先执行其一（然后重启 Codex 会话）：

```bash
codex mcp add claude-code -- npx -y @leo000001/claude-code-mcp
```

或在 `~/.codex/config.toml` 中加入：

```toml
[mcp_servers.claude-code]
command = "npx"
args = ["-y", "@leo000001/claude-code-mcp"]
```

### A.2 Codex 可直接使用的提示模板

#### 模板 1：先发现工具与资源

```text
请先通过客户端工具注册表或可调用性确认 claude_code、claude_code_reply、claude_code_check、claude_code_session 四个工具。
（可选）如果客户端支持 tools/list 协议方法，可调用 tools/list 做二次确认；不支持时跳过。
然后调用 resources/list，并读取 claude-code-mcp:///server-info、claude-code-mcp:///quickstart、claude-code-mcp:///errors 与 claude-code-mcp:///compat-report。
输出关键字段和你的结论。
```

#### 模板 2：启动并轮询到终态

```text
请调用 claude_code 在当前目录执行一个最小 smoke 任务（创建并读取 mcp_smoke.txt）。
调用参数建议包含 strictAllowedTools=true 且 allowedTools 仅保留本轮必需工具。
随后持续调用 claude_code_check(action=poll) 直到终态。
每次轮询都要打印 status、nextCursor、actions 数量。
如果返回 cursorResetTo，请先重置 cursor 再继续 poll。
如果出现 nextCursor 不变且 events 为空，按同一 cursor 重试最多 3 次，再记录为疑似异常。
Windows 场景重要约束：若你生成的路径包含 /home/ 或其他 POSIX 风格路径，必须先自检并改写为当前 cwd 下的 Windows 绝对路径后再执行。
终态时输出 result。
```

#### 模板 3：处理权限请求

```text
如果出现 waiting_permission，不要继续空轮询。
请读取 actions[] 中的 requestId，并调用 claude_code_check(action=respond_permission, requestId=..., decision=...)。
先执行一次 allow_for_session（或 allow）；若后续还有请求，再执行一次 deny(interrupt=false)。
若同一 session 内不再出现第二个请求，允许新开第二个 session 完成 deny 分支。
每次 respond_permission 后确认 permission_result；如临近超时（默认 60000ms）优先处理剩余时间最短的请求。
Windows 场景优先使用当前 cwd 下的绝对 Windows 路径，不要使用 `/home/user/...` 路径。
然后继续 poll 到终态，并说明 permission_result。
```

#### 模板 4：真实编程任务验收

```text
请在独立测试项目目录执行（可使用 §5.5 提供的内置 fixture 初始化）：先运行测试复现失败，再做最小修复，再次运行测试确认通过。
Windows 场景重要约束：若你生成的路径包含 /home/ 或其他 POSIX 风格路径，必须先自检并改写为当前 cwd 下的 Windows 绝对路径后再执行。
要求输出：失败用例、根因、修改文件、复测结果。
最后给出是否通过 verdict。
```

#### 模板 5：结束清理

```text
请调用 claude_code_session(action=list)。
对所有 running/waiting_permission 的 session 调用 action=cancel。
再 poll 一次确认终态。
再调用一次 claude_code_session(action=list) 确认没有残留 running/waiting_permission。
最后输出清理结果。
```

### A.3 Codex 场景高频误用

1. 只靠文本推理，不实际调用工具。
2. 忘记处理 `waiting_permission`，导致会话卡住。
3. 轮询不传 `nextCursor`，导致重复读事件。
4. 没有建立 `requestId -> 决策` 记录，导致并发请求漏处理。
5. 测试结束不做 cancel 清理，造成后续回归互相干扰。

### A.4 Codex 手动验收清单

1. 4 个工具可见。
2. 至少 1 个 session 走到终态并有 `result`。
3. 至少处理 1 次权限请求。
4. 至少完成 1 个真实 coding task 验收。
5. 无残留 `running/waiting_permission` 会话。
