# Subagent system — final technical decision

**Status:** implemented (Phases 0–4 + structured handoff / patch apply)  
**Package:** `pi-tian-subagents` (`packages/pi-subagents`)  
**See also:** [References](#references) — exploratory design docs in `docs/` (superseded by this ADR where they differ).

## Decision

Ship `pi-tian-subagents` as a Pi extension whose **supervisor** spawns **one child Pi process per run**, communicates over **RPC JSONL**, and returns a **bounded report** with **nested usage**. The **parent model** remains the planner; the framework does not implement chains, swarms, or a second orchestration language.

## Architecture

```text
Parent Pi (planner)
  └── pi-tian-subagents extension
        └── Supervisor (session-scoped)
              └── RpcChild (one per run)
                    └── child `pi --mode rpc` process
                          └── explicit child runtime (`report_result`)
                          └── profile-locked tools + system prompt
```

| Layer | Responsibility |
|---|---|
| **Profile** | Owns model, tools, system prompt, workspace policy, `maxTurns`, budgets (not tool args) |
| **Supervisor** | Spawn limits, lifecycle, cancellation, usage rollup, exactly-once background delivery, session teardown kill |
| **RpcChild** | JSONL transport, live `turn_start` budget, `report_result` capture, `agent_settled` completion, termination ladder |
| **Parent tool** | `subagent({ profile, task, context?, mode? })` — foreground default; `mode: background` for deferred completion |

## Core choices (locked)

| Topic | Decision | Rationale |
|---|---|---|
| Child runtime | **Process** (`pi --mode rpc`), not in-process `createAgentSession` | Killable process groups; no accidental extension/skill inheritance |
| Child protocol | **RPC JSONL** on stdin/stdout, custom reader (not Node `readline`) | Streaming, `abort`, `agent_settled`; print mode lacks lifecycle control |
| RpcClient from pi | **Do not use** | Writes child stderr to parent TTY; no detached process group; fixed sleep |
| Unit of work | **One tool call = one run** | Sibling calls = parallelism (Pi executes concurrent tools) |
| Orchestration | **Parent composes** | No `tasks[]`, no chain DSL, no `agent_swarm` |
| Capabilities | **Profile-only** | Model/tools not in tool schema — prevents self-escalation |
| Handoff | **Fixed `report_result` tool** with bounded text rendering; assistant text fallback | Portable via explicit `-e` child runtime; avoids dual completion paths and trailing JSON |
| Turn budget | **Profile `maxTurns` (default 8)** enforced on live `turn_start` | Soft boundary; abort via normal RPC termination ladder |
| Default profiles | **scout**, **planner**, **reviewer**, **oracle**, **worker** | Read-only first; worker uses git worktree |
| Model default | **Resolve in parent before spawn** | Profile may omit model → use `ctx.model`; fail if unresolvable |
| Nesting | **Disabled** (`--no-extensions` on child) + explicit trusted child runtime only | No recursive `subagent` in children |
| Background | **Implemented** | `mode: background`, exactly-once follow-up via claim/confirm delivery |
| Worktrees / writers | **Implemented** | `worker` profile; durable branch + private patch artifact; worktree removed only after durability |
| Patch apply | **Explicit `subagent_apply` with confirmation** | Never automatic for worker runs |
| MCP in children | **No extension MCP** (`--no-extensions`); env inherited | Pi has no built-in MCP; API keys via `process.env` |
| Security | **Not a sandbox** | Process isolation = context + lifecycle, not credentials |

## Tool contract

```ts
subagent({
  profile: string,           // short name or qualified id
  task: string,              // max 16 Ki UTF-16 code units (TypeBox maxLength)
  context?: string,          // max 32 Ki UTF-16 code units
  mode?: "foreground" | "background",
})

subagent_apply({
  run_id: string,            // completed worker run with patch artifact
})
```

Out of scope for the model: `model`, `tools`, `timeout`, `workspace`, `acceptance` shell verify.

## Session budgets

- Max **4** concurrent child processes per parent session
- Max **20** runs per session (hard stop on new spawns)
- Profile **`maxTurns`** default **8** (override via settings/frontmatter)
- Session **cost accumulator** with `ui.notify` warning at 80% of soft ceiling (`subagents.sessionSoftCostUsd` in settings, default $5)

## Package layout

```text
packages/pi-subagents/
  index.ts
  profiles/
  lib/
    domain.ts
    child-runtime.ts
    run-report.ts
    patch-apply.ts
    profile-catalog.ts
    profile-diagnostics.ts
    settings.ts
    trust.ts
    jsonl-reader.ts
    pi-spawn.ts
    rpc-child.ts
    supervisor.ts
    process-tracker.ts
    usage.ts
    prompt.ts
    worktree.ts
    run-store.ts
    result-delivery.ts
    ui/agents-command.ts
  test/
```

## Phased delivery

| Phase | Scope | Status |
|---|---|---|
| **0** | Foreground, scout + planner, RPC supervisor, kill tree, usage, fake-child tests | Done |
| **1** | More profiles, settings overrides, `/agents` list | Done |
| **2** | Background runs, `subagent_status`, `subagent_cancel`, exactly-once delivery | Done |
| **3** | Project profiles, trust hashing (`~/.pi/agent/subagents/approvals.json`) | Done |
| **4** | Git worktree, worker/reviewer writers; patch artifacts at `~/.pi/agent/subagents/runs/<runId>/` | Done |
| **5** | Structured `report_result`, live `maxTurns`, durable patch artifacts, `subagent_apply` | Done |

Deferred / optional later: full TUI dashboard for `/agents`, profile persistence across session reload, batch tool, recursion controls, revive.

## References

- Implementation handoff: [`subagent-implementations/oh-my-pi.md`](./subagent-implementations/oh-my-pi.md)
- Comparator survey (historical): [`subagent-implementations/comparison.md`](./subagent-implementations/comparison.md)
- Exploratory design proposal: [`subagents-system-design.md`](./subagents-system-design.md)
- Pre-implementation review: [`subagents-system-design-review.md`](./subagents-system-design-review.md)
- Pi RPC protocol: `@earendil-works/pi-coding-agent` `docs/rpc.md`

## Exit criteria (Phase 0)

1. Parent can spawn two `scout` runs in parallel (two child PIDs).
2. Session abort kills both process trees (no survivors).
3. Tool result includes nested usage totals.
4. Fake-child tests cover JSONL framing and termination without API tokens.
