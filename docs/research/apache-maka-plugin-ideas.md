# Apache Maka 调研：可以带给 pi 的插件点子

**调研对象:** <https://github.com/apache/maka>（Apache Maka, Incubating；本地优先的 AI agent workspace，Electron 桌面 + TUI/CLI + Eval）
**日期:** 2026-08-22
**结论形态:** 候选 pi 扩展清单，含优先级、MVP 范围、pi API 可行性
**已有相关研究（避免重复）:**

- `docs/tool-result-pruning-system-design.md` — Maka 的 tool-result 剪枝 + ArchiveRead，已单独研究
- `docs/subagent-implementations/maka-agent.md` — Maka 的 subagent/swarm/graph 分层，已单独研究
- `docs/subagents-system-design.md` — 我们的 subagent 设计（Maka 是参照系之一）

---

## Maka 值得学的核心思想（一分钟版）

| 思想 | Maka 的做法 | 对 pi 的启示 |
|---|---|---|
| Log is the Runtime | 所有模型消息/工具调用/结果/权限决定进 append-only 事件日志，Session/UI/context 都是投影 | pi session JSONL 已是事实源；扩展可以自己维护「工作区账本」做可恢复的多步工作流 |
| Context is not history | 剪枝/压缩只改发给模型的投影，不丢证据 | 已在 tool-result-pruning 研究中覆盖 |
| 有界 fan-out（Swarm） | 一次工具调用 1–32 个独立子任务，保序、部分失败隔离、限流退避 | pi-subagents 已有并行 sibling 调用，缺批量模板/退避/保序语义 |
| 研究即持久工作区 | Deep Research 用 JSONL 事件账本 + artifact store，可跨重启/压缩续作 | pi 完全没有等价物，且我们已有 pi-web-search / pi-subagents 可组合 |
| 侧聊 | `/side` 临时 fork，父历史只读引用，关闭即删 | pi 有 `ctx.fork`，但更简单的做法是无会话污染的一次性咨询 |
| 任务账本带证据 | blocked/failed/completed 必须带原因/证据；prompt 尾部注入有预算上限 | pi-todo / pi-goal 可直接吸收 |
| 定时任务 | ScheduledTask 统一目录：notify / session_resume / agent_run 三种效果 | pi 关掉就没了，需要 launchd/daemon 桥 |
| Eval | 声明式 spec → task×repetition×subject 网格 → 不可变 attempt → 最早有效结果 | 可做轻量版，用 `pi -p` 无头跑，服务我们自己的扩展开发 |

以下按推荐优先级展开。

---

## P1 — 高价值、现在就能做

### 1. `pi-deep-research` — 持久研究工作区（新包）

**Maka 做法**（`docs/deep-research-durable-workspace.md`，独立复现 FS-Researcher 论文）：

- 两阶段：先归档原始来源 → 再写证据笔记 → 大纲 → 分节报告 → 最终报告 + 结构化 handoff；
- 状态活在 append-only JSONL 事件账本里，大块内容（原文、笔记、章节）是带 SHA-256 的 artifact 文件；
- 所有变更工具按 tool-call id 幂等：精确重试返回既有投影，同 id 不同输入 fail-closed；
- 完成有硬性门禁：清单全部 settle、五个章节、来源、最终报告、handoff 缺一不可；
- 重启/压缩后用 `status` 工具 + 分块按需读 artifact 恢复，不用重读全部来源。

**对 pi 的价值:** 长任务（技术选型、库调研、故障复盘、写方案）目前只能一口气塞进一个 session，压缩之后就丢证据。一个持久、可断点续作、产物落盘的研究模式是 pi 目前完全缺失的能力，且和 `pi-web-search`（搜索）+ `pi-subagents`（并行读代码/读网页的 worker）天然组合。

**pi 可行性:** 高。全部用 `pi.registerTool` + 本地文件即可：

- 账本与产物放 `~/.pi/deep-research/<runId>/`（events.jsonl + artifacts/）；
- 工具面（精简为 6 个）：`research_start` / `research_save_artifact`（role: source|note|outline|section|report|handoff，派生物必须引用 source id）/ `research_checkpoint` / `research_status`（账本重投影，供恢复）/ `research_read_artifact`（分块 + hash 校验）/ `research_complete`（门禁校验后封账）；
- 幂等：pi 的 `tool_call` 事件带 call id，扩展自己做「同 id 精确重试返回旧结果」；
- 门禁与 fail-closed 全是纯函数，好测试。

**MVP 范围:** 单 session、主 agent 直接持有工具；不做 worker 调度、不做浏览器自动化、不做引用格式化（Maka 也明确把这些列为 non-goal）。报告 Markdown 落盘 + TUI 里显示进度（todo widget 或自定义 entry renderer）。

**风险:** 工具多、prompt 重；需要好的 prompt.ts 引导两阶段节奏。参考 Maka 的操作上限（artifact 512KB/次写入、64KB/次读、清单 50 项）防失控。

---

### 2. `/side` 侧聊 — 无污染的一次性咨询（新包，或并入 pi-subagents）

**Maka 做法**（`docs/side-conversation.md`）：`/side <prompt>` fork 到最新完成 turn，父历史只读引用，仅侧聊内的指令生效，关闭即删，孤儿 fork 启动时清理。入口还有选中文字带引用追问。

**对 pi 的价值:** 干活干到一半想问「这个报错什么意思」「换个思路想想」，但不想污染主线 session 的上下文和树。pi 里现在只能：开新 session（丢上下文）或硬着头皮在主线问（污染上下文）。

**pi 可行性:** 高，且有两种实现路径：

- **MVP（推荐）— 无会话 fork 的一次性咨询：** `pi.registerCommand("side")`，handler 里 `ctx.sessionManager.getBranch()` 取当前分支历史，spawn 一个 `pi --mode rpc` 无头子进程（复用 pi-subagents 的 child backend 基建），注入「以下历史只读，回答我的问题，不要继续父任务」+ 用户问题，结果以自定义 entry（`pi.appendEntry`）渲染在当前 transcript 里。主线 session 文件零改动。
- **后续 — 真 fork 版：** `ctx.fork(leafId, { position: "at" })` + `withSession` 里 `sendUserMessage(问题)`，得到可多轮追问的侧聊 session；关闭时删文件。注意 pi 的 fork 是「替换当前 session 视图」，体验和 Maka 的并排面板不同，需评估是否值得。

**MVP 范围:** 只做一次性咨询版；标题取问题首行；结果 entry 带「复制」无、带「继续追问」提示（用户再敲 `/side` 时自动带上一轮引用）。

**风险:** 子进程成本（一次模型调用的钱）；prompt 要明确禁止子进程改文件（只读 profile）。

---

### 3. `pi-subagents` 增强 — Swarm 批量 fan-out

**Maka 做法**（`docs/agent-swarm.md`）：

- 一个 `agent_swarm` 工具收 1–32 个 item，或 `prompt_template` + `{{item}}` 模板批；
- 结果保序（输入顺序），部分失败不拖累成功项，父取消时排队项标记 cancelled；
- 每项返回有界摘要 + 真实 child run 引用（可追溯），不复制 child 的 prompt/原始输出；
- Kimi 式限流退避：先放 5 个、每 700ms 放一个，被限流的项 3s/6s/12s 重试、批量容量减一，3 分钟无限流逐槽恢复；
- `resume_run_ids`：按 runId 续作既有 child，完整重放其历史，而不是把摘要拼进新 prompt。

**对 pi 的价值:** pi-subagents 已靠 sibling 并行调用拿到了并行能力，但模型要手写 N 个工具调用、结果顺序靠运气、遇到限流只会整体重试。Swarm 语义（模板、保序、有界摘要、退避、续作）是纯增益。

**pi 可行性:** 高，是现有包的自然扩展：

- 新增 `swarm` 工具（或 `subagent` 加 `items[]` 形态），内部就是 supervisor 的 worker-pool；
- 退避参数做成 profile/常量即可，pi-subagents 的 supervisor 已有并发上限概念；
- resume 需要给 run 记录持久 id（supervisor 已有 run id，落盘到 `~/.pi/subagents/runs/` 即可重放）。

**MVP 范围:** 模板批 + 保序 + 有界摘要 + 并发上限 + 取消传播。限流退避先做「失败分类 + 指数退避重试一次」，Kimi 完整算法后续再加。

**风险:** 工具 schema 复杂度上升；注意 32 上限和「children 不能再调 swarm」的防递归规则。

---

### 4. `pi-todo` / `pi-goal` 增强 — 带证据的任务账本

**Maka 做法**（`docs/session-task-ledger-lifecycle.md`）：

- 状态机含 `blocked`；进入 `blocked`/`failed`/`completed` 必须带 `blockedReason`/`failureReason`/`completionEvidence`（纯文本证据）；
- 层级短键 `T1`/`T1.1`（prompt 里引用短键不引用 UUID），父不能在有非终态子任务时完成；
- turn 尾部注入有 8,000 字符预算上限，超了就显示「省略 N 项，用 task_list 查」；终态任务 7 天后逻辑归档（不删数据，注入时排除）；
- Goal 联动门控：自主 Goal 未完成且仍有 pending/in_progress 任务时，continuation 文本附一次任务提醒，决定记为 `task_gate_decided` 事件；
- 子 agent 认领任务：`agent_spawn(task_id)` 成功不等于完成——父必须验证并补 `completionEvidence`。

**对 pi 的价值:** pi-todo 目前是「模型自说自话的清单」，没有任何机制阻止模型把没验证的事勾掉。证据字段 + goal 门控直接提升长任务的完成质量，改动量小。

**pi 可行性:** 高，全是现有包内的增量：

- pi-todo：todo item 加 `blocked` 状态 + 三个证据字段（schema 改动），渲染器显示证据；turn 尾注入（如有）加预算截断 + 省略计数；
- pi-goal：continuation 决定点检查未完任务键，注入一条提醒（一次性，不重复刷屏）。

**MVP 范围:** 证据字段 + blocked 状态 + goal 提醒。层级短键、7 天归档、子 agent 认领可后置。

---

## P2 — 有明确场景，工作量中等

### 5. `pi-schedule` — 定时任务 / Automations（新包）

**Maka 做法**（`docs/architecture/scheduled-task-unified.md`）：一个 `ScheduledTask` 名词统一目录：效果三种 — `notify.local`（本地通知）、`session_resume`（往创建它的 session 续一个 turn）、`agent_run`（冻结模板，到点开新 session 跑）；fire 前先持久化唯一 fire claim，恢复时可对账不重复执行。

**对 pi 的价值:** 「每天早上 9 点总结昨天的 git log 发通知」「每晚跑一遍测试，挂了就叫醒我」「两小时后提醒我回来看这个方案」——pi 关掉 TUI 就什么都做不了，这是和桌面 agent 的真实差距。

**pi 可行性:** 中。pi 没有常驻进程，需要一个独立调度器：

- 交付一个 `pi-schedule` CLI（同包内 bin）：`pi-schedule daemon` 常驻或（更符合 mac 习惯）生成 launchd plist 每 30s tick 一次；
- 任务目录 `~/.pi/schedule/tasks.json` + fire 账本 `fires.jsonl`（先写 claim 再执行，Maka 的对账思路直接抄简版）；
- 效果实现：notify → `osascript -e 'display notification'`；session_resume → `pi -p --session <file> "<prompt>"`（无头续 session）；agent_run → `pi -p --cwd <dir> "<task>"`；
- 模型侧 `pi.registerTool("schedule")` 创建/列出/暂停任务，用户在 TUI 里 `/schedule` 查看。

**MVP 范围:** cron 表达式 + 三种效果 + fire 账本。不做重复执行对账的完整恢复协议（launchd tick 天然幂等：先查账本再执行）。

**风险:** 无头跑 pi 会花钱——`agent_run`/`session_resume` 默认要求用户在创建时确认；通知类免确认。

### 6. `pi-eval` — 轻量评测跑批（新包）

**Maka 做法**（`packages/eval/README.md`）：声明式 spec（benchmark × executor × subjects × tasks × repetitions）→ cell 网格 → 不可变 attempt → 结果核只含 score/normalized usage/cost/duration/status/failure reason；多次 attempt 取最早有效，操作者不能挑结果。

**对 pi 的价值:** 我们自己就在不断调 prompt / 换模型 / 改扩展（比如验证 pi-tool-prune 到底省不省 token）。没有跑批工具，每次都是手工点。也可以用来做「同一任务 A/B 两个模型」。

**pi 可行性:** 中高。无头执行就是 `pi -p --cwd <worktree>`；usage 从 pi session JSONL 里读；verifier 是任意 shell 命令（exit code）+ 可选正则/文件断言；spec 是一个 JSON 文件，输出目录 append-only attempt 记录。

**MVP 范围:** task = { setup 命令?, prompt, verify 命令, timeout }；subject = { 模型/thinking level/启用的扩展集 }；跑 task × subject × N 次重复；出一张表（score、时长、token、成本）。不做 Docker 隔离、egress 代理（Maka 那套防作弊基建远超我们需要）。

**风险:** 并发跑批的成本控制——默认串行 + 每日预算上限常量。

---

## P3 — 有意思，但先放后面

### 7. `pi-bot` — IM / 远程接入桥（新包）

Maka 有 bot 扫码接入（`docs/architecture/bot-onboarding-runtime.zh-CN.md`）和远程 Runtime Host（`docs/runtime-host-remote-access.md`）。pi 已有 `--mode rpc`（JSONL RPC，见 pi 文档 `rpc.md`）。可以做一个薄桥：Telegram/飞书 bot ↔ 本地 pi RPC 子进程，让你在手机上派活、看流式输出、收完成通知。价值真实（下班路上查进度），但涉及凭证管理、并发会话映射、安全暴露面，建议等 P1/P2 落地后再评估。

### 8. Graph 式持久编排（pi-subagents 远期）

Maka Agent Graph（`docs/architecture/agent-graph-stream-scheduling-draft.md`）的核心是「child session 是算子、已提交事件是记录、SQLite 是调度控制面、主 agent 是旁路监督者，quiescence ≠ 完成」。pi-subagents 的设计文档已把 background 运行列为后续；如果做，直接吸收三个概念：①监督者工具（`view/update` 而不是每步都过父模型）；②「静默 ≠ 完成，显式 finish 才关门」；③supervisor wake——后台批 quiescent 后用 `pi.sendMessage` 唤醒父 agent 检查点。不需要 SQLite，JSONL 账本够用。

### 9. 小点子合集

| 点子 | 来源 | 落点 | 说明 |
|---|---|---|---|
| models.dev 元数据同步 | Maka `sync:model-metadata` 脚本 | pi-repo-model 增强 | 从 models.dev 拉 pricing/context window/能力表，给 `/model` 选择和成本估算提供数据；生成缓存放 `~/.pi/` |
| Worktree + patch 回写 | Maka `GitWorktreeChildExecutor.capturePatch` | pi-subagents 写型 profile | 写型子任务在独立 worktree 跑，回写以 binary diff patch 交付，父 agent 审后应用；含孤儿 worktree 启动回收 |
| Skill 目录策略 | Maka `docs/skill-catalog-policy.md` | pi-repo-skills 增强 | skill 启用按内容 hash 审批、命名空间隔离，防止仓库里夹带未审 skill |
| 队列消息 retract | Maka `docs/desktop-message-queue.md` | 需要 pi 核心支持 | pi 已有 pending 消息队列和 steer，但扩展 API 只有 `hasPendingMessages()`，没有列出/撤回接口；值得给 pi 提 feature request 而不是扩展硬做 |

---

## 明确不建议移植的

| Maka 能力 | 不移植的原因 |
|---|---|
| 事件溯源重写 / Runtime Host 单执行权威 | pi 核心已拥有 session 持久化与执行模型；扩展不应造第二 runtime（Maka 自己也反复强调 Graph「不是第二个 runtime」） |
| T1/T2 崩溃恢复协议（`runtime-resume-architecture.md`） | 面向桌面常驻进程的 SQLite 两阶段工具派兵协议；pi TUI 崩了大不了重跑，性价比极低。但其「missing result ≠ 未执行」的分类思想值得写进 pi-subagents 的后台交付容错 |
| Electron 桌面壳 / 设计系统（DESIGN.md） | 与 pi TUI 无关 |
| Windows sandbox / egress 代理 / 防作弊 eval 基建 | 平台特定或只有跑公开 benchmark 才需要 |
| 消息 queue/steer 双模 | pi 原生已支持 |

---

## 建议的动手顺序

1. **`pi-deep-research`**（新能力空白，组合现有 pi-web-search/pi-subagents，最能体现「pi 不只是聊天」）
2. **pi-todo/pi-goal 证据化**（小改动、立刻提升长任务可靠性）
3. **`/side` 侧聊**（高频小痛点，复用 pi-subagents child backend）
4. **pi-subagents swarm 语义**（模板批 + 保序 + 退避）
5. **`pi-schedule`**（打开「pi 关着也能干活」的场景）
6. 其余按需。

## 参考文档索引（Maka 仓库）

- README / ARCHITECTURE：<https://github.com/apache/maka/blob/main/ARCHITECTURE.md>
- Deep Research：<https://github.com/apache/maka/blob/main/docs/deep-research-durable-workspace.md>
- Agent Swarm：<https://github.com/apache/maka/blob/main/docs/agent-swarm.md>
- Side Conversation：<https://github.com/apache/maka/blob/main/docs/side-conversation.md>
- Task Ledger：<https://github.com/apache/maka/blob/main/docs/session-task-ledger-lifecycle.md>
- ScheduledTask：<https://github.com/apache/maka/blob/main/docs/architecture/scheduled-task-unified.md>
- Agent Graph：<https://github.com/apache/maka/blob/main/docs/architecture/agent-graph-stream-scheduling-draft.md>
- Runtime Resume：<https://github.com/apache/maka/blob/main/docs/architecture/runtime-resume-architecture.md>
- Eval：<https://github.com/apache/maka/blob/main/packages/eval/README.md>
- Work Board：<https://github.com/apache/maka/blob/main/docs/work-board-contract.md>
