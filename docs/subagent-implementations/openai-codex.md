# openai/codex — multi-agent system

**Repo:** https://github.com/openai/codex  
**Role:** Codex CLI / TUI — built-in **Multi-Agent v2** collab tools in the Rust core, not a Pi extension.

## Summary

Codex implements subagents as **child threads** managed by the core `agent_control` service. The parent thread’s model calls collab tools; each `spawn_agent` creates a new thread with injected initial communication, optional role (`agent_type`), and configurable fork context. The TUI can navigate between parent and child threads (agent picker, Alt-arrow shortcuts). Trace/reduction layer records spawn/message/close **interaction edges** between threads.

## Architecture (codex-rs)

```
codex-rs/
  core/
    tools/handlers/multi_agents_v2/
      spawn.rs          # spawn_agent handler
      wait.rs           # wait_agent — multiplexed wait with timeout
      send_message.rs   # send_message to child thread
      interrupt_agent.rs
      followup_task.rs
      list_agents.rs
      message_tool.rs   # shared message content parsing
    agent/              # agent_control, roles, spawn depth
  tui/
    multi_agents.rs     # Picker labels, history cell rendering
    app/agent_*.rs      # Navigation, status feed, picker
  rollout-trace/
    reducer/tool/agents.rs  # Interaction edges (spawn, message, close)
  protocol/             # CollabAgent*, SubAgentActivity* types
```

## Tool surface (Multi-Agent v2)

| Tool | Purpose |
|---|---|
| `spawn_agent` | Create child thread + deliver initial task message |
| `wait_agent` | Block until child activity settles (configurable timeout) |
| `send_message` | Deliver message to running child |
| `interrupt_agent` | Stop child work |
| `followup_task` | Additional task on existing child |
| `list_agents` | Enumerate children |

Legacy v1 names appear in rollout mapping (`spawn_agent` → `ToolCallKind::SpawnAgent`).

## `spawn_agent` flow (`spawn.rs`)

1. Parse args: `message`, `task_name`, optional `agent_type`, `model`, `reasoning_effort`, `service_tier`, `fork_turns`.
2. Compute `child_depth` via `next_thread_spawn_depth(&session_source)`.
3. Build spawn config from base instructions + turn config; apply model/reasoning overrides from args (unless full-history fork).
4. Apply **role** config when `agent_type` set (`apply_spawn_agent_role`).
5. Build `AgentCommunication` with spawn kind; `trigger_turn: true`.
6. Call `session.services.agent_control.spawn_agent_with_communication(...)` with:
   - `SpawnAgentOptions`: parent thread/turn ids, fork mode, environments
7. Emit `SubAgentActivityKind::Started` for TUI.
8. Return `task_name` (agent path) and optional nickname.

**Fork modes:** `fork_turns` string or full-history fork — inherits parent context slices; `fork_context` rejected in v2.

**Per-spawn overrides:** Unlike pi-tian’s profile-only design, Codex allows `model` and `reasoning_effort` on the spawn call (validated against role and effective child model).

## Thread / session model

- Each agent = **Codex thread** (`ThreadId`) with `SessionSource` metadata (agent path, nickname, role, depth).
- Parent-owned threads reject certain settings shortcuts (TUI snapshots in tests).
- Child threads can be **closed** via `CloseAgent` collab tool (interaction edge in trace reducer).
- Depth limit enforced (`spawn_agent_rejects_when_depth_limit_exceeded` test).

## `wait_agent` (`wait.rs`)

Subscribes to input-queue activity for the turn; waits with min/max/default timeout from `multi_agent_v2` config. Returns when targeted child activity completes or timeout fires. Lets parent orchestrate parallel children without blocking the whole session on one spawn.

## TUI presentation (`multi_agents.rs`)

- Agent picker entries: nickname, role bracket, running/closed state.
- History cells for spawn end, tool lifecycle, error previews.
- Keyboard: Alt+Left/Right (with macOS word-motion fallbacks) for agent navigation.
- Status feed strings: “Spawned an agent”, etc.

## Trace / observability

`rollout-trace` builds a graph:

- `InteractionEdgeKind::SpawnAgent` — parent thread → child thread
- `AssignAgentTask`, `SendMessage`, close edges
- Pending edges when recipient message not yet model-visible
- `SubAgentActivityEvent` for started/completed child lifecycle

Useful for debugging multi-agent transcripts and parent/child message delivery ordering.

## Configuration

- `multi_agent_v2` feature block in Codex config (hide spawn metadata, wait timeouts, concurrency warnings in TUI).
- **Roles** — external agent config migration (`external_agent_config_migration/`) maps roles to model, sandbox, approval policy.
- Subagent defaults can be configured per role (`spawn_agent_uses_configured_subagent_defaults` tests).

## Comparison to Pi extensions

| Aspect | Codex | Pi extensions |
|---|---|---|
| Runtime | Rust core, async Tokio | Node, Pi `ExtensionAPI` |
| Child unit | Thread | Process (nicobailon) or Session (tintinweb) |
| Tool count | Multiple collab tools | Usually one spawn + optional poll/steer |
| Capability grants | Role + spawn-time overrides | Frontmatter / profile (tintinweb) or ceiling token (nicobailon) |
| Navigation | Built-in thread switcher | FleetView / fleet (extensions) |
| Persistence | Codex thread store | Pi session JSONL / artifacts |

## SDK

Python SDK exposes generated v2 collab types (`sdk/python/src/openai_codex/generated/v2_all.py`); RPC methods tested in `test_client_rpc_methods.py`.
