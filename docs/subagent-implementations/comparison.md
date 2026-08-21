# Subagent implementations comparison

Survey of how five projects implement delegated / child agent work. This repo’s own design notes live in [`subagents-system-design.md`](../subagents-system-design.md) and [`subagents-system-design-review.md`](../subagents-system-design-review.md).

| Project | Type | Child runtime | Primary tool(s) | Parallelism | Background |
|---|---|---|---|---|---|
| [nicobailon/pi-subagents](./nicobailon-pi-subagents.md) | Pi extension | **Child Pi process** (`--mode json -p`) | `subagent` (single / parallel / chain) | Sibling tool calls + explicit `parallel` / chain modes | Yes — file-backed async runs, fleet UI |
| [tintinweb/pi-subagents](./tintinweb-pi-subagents.md) | Pi extension | **In-process** `createAgentSession()` | `Agent`, `get_subagent_result`, `steer_subagent` | Sibling `Agent` calls + queued background pool (default 4) | Yes — queue, notifications, schedule |
| [openai/codex](./openai-codex.md) | Built-in (Rust core) | **Child thread** via `agent_control` | `spawn_agent`, `wait_agent`, `send_message`, … | Parent orchestrates; `wait_agent` multiplexes | Threads persist; parent can navigate away |
| [maka-agent](./maka-agent.md) | Full agent app (TS monorepo) | **Child Session** in same runtime (+ legacy inline child runs) | `agent_spawn`, `agent_swarm`, Agent Graph tools | `agent_swarm` (≤32 items, concurrency 3–5) | Agent Graph / Team (durable scheduling) |

## Architectural axis

### Process vs in-process vs thread

```
nicobailon          tintinweb              codex                 maka
─────────           ─────────              ─────                 ────
Parent Pi           Parent Pi              Parent thread         Parent Session
    │ spawn           │ createAgentSession     │ spawn_agent           │ spawnChildSession
    ▼                 ▼                      ▼                       ▼
Child Pi process    Child AgentSession     Child Codex thread      Child Session (SQLite + JSONL)
(JSON print mode)   (same Node process)    (Rust async runtime)    (same Electron/Node host)
```

**nicobailon** maximizes isolation: each run is a fresh Pi CLI child. Communication is stdout JSON lines plus many `PI_SUBAGENT_*` env vars for steering, capability ceilings, and nested routing.

**tintinweb** maximizes integration: children are ordinary Pi sessions created inside the parent process. Lower spawn cost, shared event loop, but a child crash or runaway loop affects the parent host.

**codex** uses the core’s thread model: each child is a full Codex thread with its own transcript, managed by `agent_control`. The TUI can switch between parent and child threads.

**maka** treats a child as a **durable Session** with provenance on the header (`subagentParent`, `subagentRuntime`). The runtime kernel serializes execution per session; children share the host process but have separate storage and tool boundaries.

### Tool surface and orchestration style

| | Orchestration model | Chain / workflow | Capability control |
|---|---|---|---|
| nicobailon | One `subagent` tool with `mode`: single, `parallel`, `chain`; slash workflows | Built-in chain language with `{previous}` substitution; saved prompt workflows | Capability ceiling env token; agent frontmatter; per-run overrides in slash commands |
| tintinweb | Claude Code–style: spawn + poll + steer | Parent model composes; no chain DSL | `.pi/agents/*.md` frontmatter (`tools`, `extensions`, `disallowed_tools`) |
| codex | Multi-agent v2 tool family | Parent uses `spawn_agent` + `wait_agent` + `send_message` | Role (`agent_type`) + optional per-spawn `model` / `reasoning_effort` |
| maka | Layered: spawn → swarm → graph | `agent_swarm` for batch; Agent Graph for durable dynamic graphs | Agent catalog profiles with strict contracts (`workspace`, `write_back`, tool lists) |

### Context inheritance

- **nicobailon**: `context: fresh | fork`; fork-context module; optional parent conversation fork.
- **tintinweb**: `inherit_context` forks parent messages into the child session.
- **codex**: `fork_turns` / full-history fork modes on `spawn_agent`; role-based config snapshots.
- **maka**: Child Session starts with an explicit task prompt; resume replays full `RuntimeEvent` history via `resumedFromRunId`.

### Isolation for writers

All four support git worktree isolation for concurrent writers:

- nicobailon: `runs/shared/worktree.ts`
- tintinweb: `src/worktree.ts` — auto-commit branch on completion
- codex: sandbox/runtime reapplied per role (core tests)
- maka: `GitWorktreeChildExecutor` with lease-based deterministic paths

### Nesting / recursion

| Project | Default | Mechanism |
|---|---|---|
| nicobailon | Configurable depth (`maxSubagentDepth`); fanout-child extension | Env-based depth + capability ceiling intersection |
| tintinweb | Depth 2; opt-in via `allowed_subagents` frontmatter | Ownership-scoped nested tools; children stopped when parent finishes |
| codex | Depth limit in core (`spawn_agent_rejects_when_depth_limit_exceeded`) | `next_thread_spawn_depth` from session source |
| maka | `agent_swarm` cannot nest; Agent Graph is supervisor-only | Profile tool lists exclude swarm/graph tools from children |

### Observability

- **nicobailon**: Fleet view, slash commands (`/subagents`), artifacts dir, JSONL transcripts, watchdog (LSP diagnostics, review loops), delegation API for extensions.
- **tintinweb**: Widget, FleetView, conversation viewer overlay, `pi.events` bus (`subagents:created`, `completed`, …), output transcript files.
- **codex**: TUI agent picker, Alt-arrow navigation, collab tool-call history cells, rollout-trace interaction edges.
- **maka**: Tool-activity UI, child progress projector, Agent Graph client projection / timeline, SQLite session catalog.

## Implications for `@tian.zuo/pi-subagents`

The design in [`subagents-system-design.md`](../subagents-system-design.md) aligns closest with **nicobailon** (process-per-run, profile-owned capabilities, no chain DSL) but proposes **RPC mode** instead of nicobailon’s **JSON print mode** (`--mode json -p`). RPC gives streaming `agent_settled` and mid-run abort; print mode is simpler but weaker on lifecycle edges.

**tintinweb** is the reference for Pi-native UX (Claude Code tool names, FleetView, steering) if the extension runs in-process or embeds `createAgentSession` in the supervisor.

**codex** shows a production multi-tool collab surface (`spawn` / `wait` / `message` / `interrupt`) and thread-per-child navigation — relevant if pi eventually exposes thread-like session switching.

**maka** is the deepest on **durable child sessions**, graph scheduling, and migration from legacy inline child runs — useful for long-horizon background work and auditability, but far beyond a Pi extension’s scope.

## Per-project docs

- [nicobailon/pi-subagents](./nicobailon-pi-subagents.md)
- [tintinweb/pi-subagents](./tintinweb-pi-subagents.md)
- [openai/codex](./openai-codex.md)
- [maka-agent](./maka-agent.md)

## Repositories

- https://github.com/nicobailon/pi-subagents
- https://github.com/tintinweb/pi-subagents
- https://github.com/openai/codex
- https://github.com/maka-agent/maka-agent
