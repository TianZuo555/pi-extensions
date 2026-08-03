# maka-agent

**Repo:** https://github.com/maka-agent/maka-agent  
**Role:** Full desktop agent application (Electron) with its own runtime, storage, and multiple delegation layers — not a Pi extension.

## Summary

Maka implements subagent work at several levels of ambition:

1. **Foreground catalog child** — `agent_spawn` tool → `spawnChildSession` (durable child Session).
2. **Bounded batch** — `agent_swarm` → up to 32 items, worker-pool concurrency.
3. **Agent Graph** — SQLite-backed dynamic graphs, operators as child Sessions, supervisor tools.
4. **Legacy path** — `spawnChildAgent` inline child runs inside parent session (being superseded by child Sessions).

Children are **Sessions** in the same host process with separate SQLite/JSONL storage, execution boundaries, and header provenance — not separate OS processes.

## Package map

```
packages/
  runtime/src/
    subagent-tools.ts       # agent_spawn, agent_list, agent_output
    agent-swarm-tools.ts    # agent_swarm batch fan-out
    session-manager.ts      # spawnChildSession, spawnChildAgent, graph provision
    agent-run.ts            # Per-turn execution, lineage, durability
    stream-graph-coordinator.ts  # Agent Graph supervisor loop
    stream-graph-supervisor-tools.ts
    tool-runtime.ts         # MakaToolContext.spawnChildSession hook
  storage/src/
    git-worktree-child-executor.ts  # Lease-based worktrees
    session-store.ts, sqlite-*      # Durable session metadata
  ui/src/tool-activity/     # Subagent result previews in chat
docs/
  agent-swarm.md
  architecture/agent-graph-stream-scheduling-draft.md
```

## Agent catalog

Builtin definitions in `agent-catalog.ts` (`BUILTIN_AGENT_DEFINITIONS`):

- Each profile declares: `tools`, `permissionMode`, `contract.workspace` (`same_workspace` | `worktree`), `supportedWriteBack` (`summary` | `patch`), `systemPrompt`.
- `buildChildAgentTools()` exposes profile-specific tool subsets to children.

Profiles are validated at spawn: write-back mode and isolation must match contract (`subagent-tools.ts` Zod `superRefine`).

## `agent_spawn` tool

```ts
agent_spawn({
  profile: "local_read",      // enum from catalog
  task: "...",                // bounded string
  write_back?: "summary",     // must be supported by profile
  isolation?: "same_workspace",
  task_id?: "..."            // optional task ledger binding
})
```

Implementation (`buildSubagentSpawnTool`):

1. Validate profile contract.
2. Call `ctx.spawnChildSession({ ... })` on `MakaToolContext`.
3. Project child progress via `ChildAgentProgressProjector` for parent UI.
4. Return structured `ToolResultContent` with `kind: 'subagent'`.

**Foreground only** — tool description states bounded foreground child; background is Graph/Team territory.

## Child Session (`spawnChildSession`)

`SessionManager.spawnChildSession` (`session-manager.ts`):

1. Dedupe in-flight spawns by `childSessionSpawnKey` + request fingerprint.
2. Claim parent execution via `runtimeKernel.claimExecution(parentSessionId)`.
3. Read parent header, run, execution boundary; assert active parent run.
4. `provisionChildWorkspace` — optional git worktree via `GitWorktreeChildExecutor`.
5. `store.createSubagent({ ... })` — creates child header with:
   - `subagentParent`: parent session id, `spawnedBy` (run/turn/toolCallId), optional swarm metadata
   - `subagentRuntime`: frozen definition snapshot (tools, prompt, profile)
   - `subagentSpawn`: initial turn/run ids + fingerprint
   - `subagentWorkspace`: worktree binding if applicable
6. Run initial child turn through normal runtime kernel path.

**Key design:** first child run has **no** `parentRunId` on the run — it is session-inline history; later turns use only child history. Cross-session provenance lives on the **header**.

`SubagentExecutionRef` (`subagent-execution.ts`) bridges migration:

- `child_session` — `{ sessionId, currentRunId? }`
- `legacy_child_run` — `{ sessionId, runId }` for old inline children

## `agent_output` tool

Inspect child output with explicit locators:

- `child_session_latest`, `child_session_run`
- Legacy: `legacy_run`, `legacy_turn`
- Views: `runtime_events` (default) vs `result` (final committed text)

## `agent_swarm`

See [`docs/agent-swarm.md`](https://github.com/maka-agent/maka-agent/blob/main/docs/agent-swarm.md) in the Maka repo.

- 1–32 items per call; `max_concurrency` default 3, cap 5.
- Template batches: `prompt_template` + `{{item}}` placeholder.
- `resume_run_ids` — continue prior child runs with full `RuntimeEvent` replay (`resumedFromRunId` lineage).
- Shared child-run permits across spawn and swarm.
- Rate-limit backpressure (Kimi-style) with adaptive capacity.
- Children cannot call `agent_swarm` (no nested batches).

Execution: `runAdaptiveSwarm` in `adaptive-swarm.js`; each item is a normal child `AgentRun`.

## Agent Graph

`stream-graph-coordinator.ts` — durable supervisor for dynamic multi-agent work:

- Operators materialized as child Sessions via `provisionAgentGraphOperator`.
- SQLite stores schedule, intent claims, client projection.
- Supervisor tools in `stream-graph-supervisor-tools.ts` (yield permits, observe topology).
- Reconciliation loop `reconcileAgentGraphSchedule` fires scheduled work into child sessions.

Documented as “schedule, not a second runtime” — child Sessions are operators; committed `RuntimeEvents` are records.

## Git worktree isolation

`GitWorktreeChildExecutor`:

- Deterministic lease id → worktree path under `storageRoot/subagent-worktrees/`.
- In-flight dedupe per lease; orphan recovery on startup.
- `capturePatch` — binary diff from base commit for `write_back: patch`.
- Worktrees **survive** terminal child runs for resume/follow-up.

## UI

- `tool-activity/agent-preview.tsx` — subagent rows in chat.
- `session-history-list.tsx` — subagent session grouping.
- Session catalog queries filter subagent children (`sqlite-session-catalog-query.ts`).

## Execution boundary

`SessionManager` ties `ExecutionBoundary` (sandbox authority) per session. Child permission mode derived from profile; parent `bypass` can flow to child only where catalog allows.

## Comparison snapshot

| Layer | Unit | Durability | Best for |
|---|---|---|---|
| Main agent | Session turn | Full | Direct work |
| `agent_spawn` | Child Session | SQLite + JSONL | One specialist task |
| `agent_swarm` | Many child runs | Same | Parallel independent items |
| Agent Graph | Child Session operators | SQLite schedule + graph | Dynamic dependent work |
| Agent Team | (separate) | Task ledger + mailbox | Long-lived workers |

## vs Pi extensions

Maka owns persistence, sandbox, UI, and graph scheduling end-to-end. Pi extensions delegate to Pi’s session model and TUI widgets. Maka’s **child Session** pattern is the closest analog to “fresh context + attributable provenance,” but with enterprise durability (fingerprints, continuation claims, terminal run facts) far beyond typical extension scope.
