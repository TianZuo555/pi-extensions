# Review: `subagents-system-design.md`

**Reviewing:** [`docs/subagents-system-design.md`](./subagents-system-design.md)
**Verified against:** pi `0.80.10` (`@earendil-works/pi-coding-agent`) — docs, `dist/**` type declarations, compiled RPC client, and `examples/extensions/subagent`
**Comparators surveyed:** Claude Code / Claude Agent SDK subagents, Codex CLI multi-agent system, opencode `task` tool
**Status:** review notes. Recommends changes before implementation starts.

---

## 1. Verdict

The architecture is sound and unusually well-informed. It is a better design than pi's own bundled example and closer to correct on lifecycle and delivery than what Codex CLI and Claude Code ship today.

The objections below are **not** that the design is wrong. They are:

1. **Scope** — Phase 1 as written is not shippable; it is 3-4 phases wearing one label.
2. **Three factual gaps** against pi 0.80.10 that change implementation work.
3. **Two defaults** that should be inverted.
4. **Six omissions**, one of which (test strategy) makes the 16 invariants unverifiable as written.

Recommendation: adopt the architecture, recut Phase 1 into a smaller Phase 0, fix the factual gaps, and make the two default inversions.

---

## 2. What the design gets right

These were checked against source, not accepted on trust.

| Design claim | Status | Evidence |
|---|---|---|
| RPC needs a custom JSONL reader; Node `readline` is non-compliant | ✅ Correct | `docs/rpc.md:28-39` — "Node `readline` is not protocol-compliant … it also splits on `U+2028` and `U+2029`" |
| `agent_settled` is later and safer than `agent_end` | ✅ Correct | `docs/rpc.md:841-842` — `agent_end` "may still be followed by retry, compaction, or queued continuations" |
| Nested tool `usage` contributes to native session totals | ✅ Correct | `docs/extensions.md:1955` — persisted on the tool result, included in footer, `/session`, RPC stats |
| There is **no** API to amend a persisted tool result's `usage` | ✅ Correct | No `amend`/`updateToolResult`/`recordUsage`/`setUsage` anywhere in the public surface |
| Sibling tool calls execute concurrently | ✅ Correct | `docs/extensions.md:757` — "preflighted sequentially, then executed concurrently" |
| Every proposed child CLI flag exists | ✅ Correct | `--no-extensions`, `--no-skills` + `--skill`, `--no-themes`, `--no-prompt-templates`, `--no-context-files`, `--tools`, `--session-dir`, `--no-approve`, `--model`, `--thinking` |
| RPC mode has a working extension UI sub-protocol, so children *could* prompt the user | ✅ Correct, and correctly forbidden | `docs/rpc.md:1143-1164` — `ctx.hasUI` is `true` in RPC mode |

The strongest individual calls, all of which should survive any rescope:

- **No chain DSL and no `{previous}` substitution.** The bundled example has both; they hide orchestration from the parent transcript and copy unbounded prior output into a new prompt.
- **No `tasks: []` parameter.** One run per tool call gives each task its own cancellation, renderer, usage, and failure boundary for free.
- **Capabilities live in the profile, not in tool arguments.** This is the single most important security decision in the document. Codex CLI permits per-spawn `model` overrides; making capability grants unreachable from tool input is stricter and better.
- **Process-per-run rather than a pooled long-lived child.** The stated reasoning (hidden conversation state, stale repo assumptions, harder recovery) is right, and startup cost is genuinely irrelevant at task granularity.
- **Foreground default, justified by usage accounting** rather than by taste.
- **Documenting the background usage-accounting hole instead of hiding it.** Rare and correct.

---

## 3. Factual gaps against pi 0.80.10

### 3.1 `RpcClient` is already exported — and must not be used

`dist/index.d.ts:27` exports `RpcClient`, `RpcClientOptions`, `RpcCommand`, `RpcEventListener`, `RpcResponse`, `RpcSessionState`. The design proposes writing `src/rpc-child.ts` from scratch without mentioning that a client ships in the box. Any reviewer will ask why.

The answer is in the compiled client, and it is disqualifying for this use case:

```js
// dist/modes/rpc/rpc-client.js
childProcess.stderr?.on("data", (data) => {
  this.stderr += data.toString();
  process.stderr.write(data);          // (1) writes child stderr to the parent TTY
});

const childProcess = spawn("node", [cliPath, ...args], {
  cwd: this.options.cwd,
  stdio: ["pipe", "pipe", "pipe"],     // (2) no `detached: true` → no process group
});

await new Promise((resolve) => setTimeout(resolve, 100));  // (3) fixed startup sleep
```

1. `process.stderr.write` corrupts the parent TUI render.
2. Without `detached: true` there is no process group, so `process.kill(-pid, …)` is unavailable and **invariant #6 (no surviving process tree) cannot be satisfied**.
3. A 100 ms sleep as readiness detection is a race.
4. It hardcodes `node` and a relative `"dist/cli.js"`, which breaks under the packaged `pi` bin, Bun, and mise shims. The bundled example already solves this properly via `process.execPath` + `process.argv[1]` (`examples/extensions/subagent/index.ts:250-259`).

**Action:** add a *"Why not `RpcClient`"* subsection. Reuse its `attachJsonlLineReader` framing approach conceptually; reject its process ownership model. This reframes invariant #11 from "we need a parser" to "we need a parser because the shipped one's owner process model is wrong for a supervised child."

### 3.2 There is no RPC `exit` command — closing stdin is the graceful path

Enumerating every command in `dist/modes/rpc/rpc-types.d.ts` yields 32 commands. There is no `exit`, `quit`, or `shutdown`. The actual graceful termination path is stdin EOF:

```js
// dist/modes/rpc/rpc-mode.js:627
process.stdin.on("end", onInputEnd);
```

The design's termination ladder is therefore missing its first rung. It should read:

```
abort (RPC)
  → wait for agent_settled (bounded)
  → close child stdin                    ← currently absent from the design
  → wait for natural exit (bounded)
  → SIGTERM to process group
  → deadline
  → SIGKILL to process group
```

Skipping stdin closure means every clean shutdown is reported as a signal kill, which pollutes diagnostics and makes "did the child exit cleanly?" unanswerable.

### 3.3 `terminate: true` is batch-scoped, which weakens the `report_result` contract

From `docs/extensions.md:1959`:

> **Early termination:** … This only takes effect when **every** finalized tool result in that batch is terminating.

The design assumes `report_result` returning `terminate: true` ends the child run. It does not, if the model emits `report_result` **alongside** another tool call in the same assistant message — a common pattern (`read` + `report_result`). In that case the child takes another turn and may call `report_result` a second time.

**Action:**
- The supervisor must treat the **first** `report_result` as authoritative and ignore later ones.
- Run completion must be driven by `agent_settled` / `maxTurns` / timeout, with `terminate` as an optimisation only.
- Extend invariant #2 to: *a run reaches at most one terminal state, and at most one report is captured even if the child reports repeatedly.*

---

## 4. Two defaults to invert

### 4.1 Make the structured report optional, not required

Current design: `report_result` is required, with bounded final text as a fallback and a `completed-unstructured` diagnostic state.

Comparators both went the other way. Claude Code uses a deliberately **text-only return channel**. Codex returns prose summaries and distilled takeaways. Neither mandates a schema at the handoff boundary.

Costs of mandating it here:

- Two completion paths and an extra pseudo-state to test and render.
- It penalises exactly the models this system wants to use — cheap, fast models for `scout`, which are the least reliable at emitting a final tool call with a nested schema.
- It buys nothing the design doesn't already discard: invariant #11 of the trust model already says *"treat reports as untrusted data; the parent verifies evidence and changes before acting."* A schema-valid report is not a more trustworthy report.

**Recommendation:** the child's **final assistant text is the report**. `report_result` becomes an *optional enrichment* that attaches `evidence`, `changes`, `checks`, `questions`, and `artifacts` when the model chooses to provide them. Status (`completed` / `blocked` / `failed`) can still be required *when the tool is called*. This deletes a state, deletes a fallback branch, and widens model compatibility.

### 4.2 Reconsider `model: inherit` as the built-in default

The design correctly identifies the hazard:

> A dynamic provider registered only by a parent extension may not exist in a child started with extension discovery disabled.

…and then makes `inherit` the default for all built-in profiles — i.e. the default configuration is the one most likely to fail, and it fails *after* spawn, as a child startup error.

**Recommendation:** pick one.

- **(a)** Resolve `inherit` eagerly in the parent, validate the model is child-resolvable under `--no-extensions`, and hard-fail **before** spawn with an actionable message; or
- **(b)** Default built-ins to a concrete inexpensive model and make `inherit` explicit opt-in.

(a) is better if the extension can enumerate child-resolvable models cheaply; (b) is better if it cannot.

---

## 5. Omissions

### 5.1 No session-level cost ceiling *(highest priority omission)*

Profiles carry a per-run soft `maxCost`. Nothing caps aggregate spend. With 4 concurrent and 16 queued, a single parent turn can authorise 20 runs. Codex's own documentation leads with this risk:

> Because each subagent does its own model and tool work, subagent workflows consume more tokens than comparable single-agent runs.

Per-run budgets are not capability control. **Add a session-wide aggregate cost/run ceiling** with a user-visible warning as it is approached, and a hard stop that refuses new runs rather than silently continuing.

### 5.2 No test strategy for the 16 invariants

The document ends with 16 invariants and asserts the design is incomplete without tests proving them. It does not say how. Most of them cannot be tested against a real child without spending tokens and accepting nondeterminism:

- #1 at most one child per run
- #2 at most one terminal state
- #6 no surviving process tree across abort/timeout/reload/quit/crash
- #11 chunk boundaries, split UTF-8, CRLF, `U+2028`/`U+2029`
- #16 no retry after possible spawn

**Add a "Test harness" section specifying a scripted fake child** — a small executable that speaks the RPC JSONL dialect and can be driven to:

- emit split UTF-8 mid-multibyte-character, `\r\n`, and `U+2028` inside JSON strings;
- emit `agent_end` and then exit **without** `agent_settled`;
- call `report_result` twice;
- call `report_result` batched with another tool call (see §3.3);
- ignore `SIGTERM` and require `SIGKILL`;
- spawn a grandchild that outlives it;
- hang after accepting a prompt;
- exit non-zero after producing valid output.

This repository already has the pattern: `packages/pi-background-terminals/crash-exit.fixture.ts`. Name it in the design. Without it, invariants 1-16 are aspirations.

### 5.3 Compaction during a live foreground run

Branch navigation is handled thoroughly (launch-leaf ancestry, detached results). Compaction is not addressed at all, yet a long foreground run can straddle an automatic compaction that rewrites the parent context the result is about to land in. At minimum, state the intended behaviour: ignore, defer, or annotate.

### 5.4 Interaction with `pi-background-terminals`

Both extensions spawn process trees in one pi session, each with an independent cap: 4 subagents (each able to run `bash`, in `worktree`/`shared-write` profiles) plus 8 background terminals. There is no shared budget and no shared view. At minimum, acknowledge it; ideally, have `/agents` and `/ps` cross-reference, and consider a shared spawn budget.

### 5.5 Storage path ignores `PI_CODING_AGENT_DIR`

The design hardcodes `~/.pi/subagents/`. Per `docs/environment-variables.md:76`, `PI_CODING_AGENT_DIR` overrides the config directory (default `~/.pi/agent`). Use the resolved agent dir — e.g. `<agentDir>/subagents/` — so the extension respects user configuration and stays consistent with the rest of the repo's `~/.pi/...` convention.

### 5.6 Fan-out is an untested empirical assumption

Dropping `tasks: []` bets the system's entire parallelism story on the parent model spontaneously emitting sibling `subagent` calls. Two reasons for caution:

- **Codex went the opposite way.** It ships a `spawn_agents_on_csv` batch tool alongside `spawn_agent`, presumably because models under-parallelize when parallelism is implicit.
- `docs/extensions.md:757` says "in the **default** parallel tool execution mode," implying a sequential mode exists. In that mode, fan-out silently degrades to serial execution with no error and no warning.

**Actions:** (1) make "the parent reliably emits ≥2 sibling calls for an obviously parallel task" a measured **Phase 0 exit criterion**, not an assumption; (2) detect non-parallel execution mode and warn, or document the degradation.

### 5.7 The Effect v4 decision is deferred, not made

The design says the package "can use the same scoped Effect v4 approach as `pi-background-terminals`." Per `AGENTS.md` that is not a free choice — it means a second package on a pinned prerelease `effect`, a second `tsconfig.json` outside the root typecheck, and a second CI typecheck invocation. It is defensible for a genuinely concurrent supervisor with scoped cleanup and `Deferred` settlement. Decide it explicitly and state the cost.

---

## 6. Scope: recut Phase 1

Calibration from this repository and the pi tree:

| Reference | Size | Domain |
|---|---|---|
| `examples/extensions/subagent/index.ts` | 1,015 lines | single + parallel + chain, `--mode json`, no lifecycle guarantees |
| `packages/pi-background-terminals/**` | ~3,015 lines | strictly simpler domain: no profiles, no trust, no branch delivery |
| **This design as written** | realistically **5-8k lines** + fixtures | 5 phases, 12 modules, worktrees, trust hashing, exactly-once branch-aware delivery, 16 invariants |

Phase 1 as specified already contains profile discovery + validation, an RPC transport, a child runtime extension, cancellation and process-tree cleanup, a streaming renderer, and usage aggregation. That is not one milestone. It also conflicts with this repo's stated working agreement: *"prefer small, reviewable changes."*

### Proposed Phase 0 (shippable)

**In:**

- User + built-in profile discovery and validation
- **Two** built-ins only: `scout`, `planner` — both `shared-readonly`
- One `subagent` tool; foreground only
- RPC transport with a compliant JSONL reader
- Child runtime: fixed worker prompt, path/capability guards
- Termination ladder per §3.2, process-group kill, abnormal-parent-exit safety net
- Text report (structured enrichment optional, per §4.1)
- Nested usage in the tool result
- Compact tool renderer with bounded streaming
- Fake-child fixtures for the invariants Phase 0 touches (#1, #2, #6, #7, #11, #12, #16)

**Out — deferred:**

- Qualified profile ids, project profiles, trust/hash approval → Phase 2
- `/agents` dashboard, run store, retention → Phase 2
- **`subagent_cancel`** → Phase 3. It is dead weight in a foreground-only system: the tool signal already cancels, and users get cancellation from `/agents`. Ship it with background runs, which is the only mode that needs it.
- Background mode, exactly-once delivery, branch ancestry → Phase 3
- `worktree`, `shared-write`, writers, patch/apply → Phase 4

Estimate: ~1,200 lines. It validates the two things that actually carry risk — **does the parent fan out?** and **can the supervisor always kill the tree?** Every deferred item is refinement on top of a proven kernel. Do not build worktrees before Phase 0 has shipped and been used.

---

## 7. Structural suggestion

Move **"Native usage-accounting limitation"** out of *Foreground and background semantics* and into **Core decisions**.

It is the most consequential finding in the document. It is *why* foreground is the default, *why* background is Phase 3, and *why* the API is shaped around a tool call that stays open. At its current depth, a reader encounters the background design before learning that background mode is a deliberate compromise against a platform limitation.

---

## 8. Action checklist

Ordered by priority.

| # | Action | Section | Priority |
|---|---|---|---|
| 1 | Recut Phase 1 into the smaller Phase 0; defer `subagent_cancel`, `/agents`, project profiles, worktrees | §6 | **High** |
| 2 | Add a "Test harness" section specifying the scripted fake child | §5.2 | **High** |
| 3 | Add session-level aggregate cost/run ceiling | §5.1 | **High** |
| 4 | Add stdin-closure rung to the termination ladder | §3.2 | **High** |
| 5 | Handle batch-scoped `terminate`; first report wins; extend invariant #2 | §3.3 | **High** |
| 6 | Add "Why not `RpcClient`" subsection | §3.1 | Medium |
| 7 | Make the structured report optional; final text is the report | §4.1 | Medium |
| 8 | Resolve and validate `inherit` before spawn, or default to a concrete model | §4.2 | Medium |
| 9 | Make measured parent fan-out a Phase 0 exit criterion | §5.6 | Medium |
| 10 | Use `<agentDir>/subagents/`, honouring `PI_CODING_AGENT_DIR` | §5.5 | Low |
| 11 | State compaction-during-run behaviour | §5.3 | Low |
| 12 | Acknowledge `pi-background-terminals` process-budget overlap | §5.4 | Low |
| 13 | Decide Effect v4 explicitly and state the CI/tooling cost | §5.7 | Low |
| 14 | Promote the usage-accounting limitation into Core decisions | §7 | Low |

---

## 9. Comparator notes

Context for the design choices, from the three systems surveyed.

**Claude Code / Claude Agent SDK.** Subagents are isolated instances spawned via a `Task` tool, each with its own context window, system prompt, and tool allowlist. Communication is a **text-only return channel**. Recursive spawning is prevented by a hard `depth = 1` constraint. Worktree isolation exists for parallel work. → Independently confirms three of this design's decisions: fresh context, no recursion, per-profile tool allowlists. Contradicts the mandatory structured report.

**Codex CLI.** Agents are TOML files in `~/.codex/agents/` (personal) and `.codex/agents/` (project), requiring `name`, `description`, `developer_instructions`, and optionally `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`. Concurrency is capped by `agents.max_concurrent_threads_per_session`. Native tools: `spawn_agent`, `send_message`, `followup_task`, `interrupt_agent`, `list_agents`, `wait_agent`, plus `spawn_agents_on_csv` for batch fan-out. Subagents **inherit the parent's sandbox and permission mode**, overridable per agent. Custom agents shadow built-ins by name. → Notable divergences: Codex permits per-spawn model overrides (this design correctly forbids it); Codex lets custom agents shadow built-ins (this design correctly forbids silent shadowing); Codex ships an explicit batch tool (see §5.6); Codex exposes agent-to-agent messaging and steering, which this design correctly defers to Phase 5.

**opencode.** A `task` tool taking `description`, `prompt`, `subagent_type`, and an optional `task_id` for **resuming** a prior task. Recent work adds dynamic inline agent config and subagent-to-subagent delegation with budgets and hierarchical session navigation. → Its `task_id` resume path is the design's Phase 5 "resume a completed child session for one follow-up." Its move toward nested delegation with budgets is the direction this design explicitly declines; declining it initially is the right call, but note that two of three comparators converged on nesting, so the `depth` field should exist in the run record from day one even while capped at 1.

**Shared finding across all three:** the primary justification is context hygiene — keeping exploration noise, logs, and stack traces out of the main thread — not autonomy or agent society. This design's framing ("fresh context", "the parent plans") matches the industry consensus and its non-goals list is well-aimed.

---

## 10. Bottom line

Adopt the architecture. It is deterministic where it should be deterministic, honest about platform limits, and correctly refuses to build a second planner. Three changes before implementation:

1. **Shrink the first milestone** to a foreground, read-only, two-profile kernel with a fake-child test harness.
2. **Fix the three platform gaps** — `RpcClient` rejection rationale, stdin-closure termination rung, batch-scoped `terminate`.
3. **Add the aggregate cost ceiling** and make the structured report optional.

Then let real usage decide whether background runs, worktrees, and writers are worth their complexity.
