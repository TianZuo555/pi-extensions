# nicobailon/pi-subagents

**Package:** `pi-subagents` (npm)  
**Repo:** https://github.com/nicobailon/pi-subagents  
**Role:** Pi extension — delegation framework with builtin agents, chains, parallel runs, background async, and extension APIs.

## Summary

The parent Pi session exposes a `subagent` tool. Each invocation spawns a **separate child Pi CLI process** running in JSON print mode (`--mode json -p`), not in-process `createAgentSession`. The supervisor parses the child’s stdout as structured events, streams progress to the TUI, and collects a bounded result. Background runs detach to a file-backed async subsystem with fleet management, steering inboxes, and completion notifications.

## Core layout

```
src/
  extension/          # Tool registration, schemas, RPC bridge, config
  runs/
    foreground/       # Sync execution, chain execution, subagent-executor
    background/       # Async runner, scheduled runs, wait tool, fleet view
    shared/           # pi-spawn, pi-args, child-protocol, budgets, worktree
  agents/             # Agent discovery, frontmatter, memory, skills
  api/                # delegation, background-work, capability-ceiling, preflight
  intercom/           # Native supervisor channel, result intercom
  slash/              # /subagents commands, workflows, delegation bridge
  watchdog/           # Optional review/LSP watchdog on main and child
  tui/                # Fleet rendering, status formatting
```

## Child process model

1. **Spawn command** — `getPiSpawnCommand()` resolves `node` + the same Pi entry script as the parent (`process.execPath` / package root probing in `pi-spawn.ts`).
2. **CLI args** — `buildPiArgs()` assembles flags: `--session` / `--session-dir`, `--model`, `--tools`, extension paths, env-injected budgets, capability ceiling token, steer inboxes, nested path metadata.
3. **Base mode** — `baseArgs: ["--mode", "json", "-p"]` in `runs/foreground/execution.ts` and background runner.
4. **Protocol** — stdout JSON lines parsed via bounded line readers (`child-protocol.ts`); stderr tail-capped; lifecycle projected from events like `agent_settled`.
5. **Env contract** — extensive `PI_SUBAGENT_*` variables in `pi-args.ts` (parent session id, run id, depth, capability token, steer dirs, fanout child marker, etc.).

This is **stronger isolation** than tintinweb’s in-process sessions but **different** from pi-tian’s proposed RPC supervisor (stdin/stdout JSONL RPC commands vs one-shot print).

## Tool: `subagent`

Registered in `src/extension/index.ts`.

| Parameter area | Behavior |
|---|---|
| `mode` | `single` (agent + task), `parallel` (tasks array), `chain` (ordered steps with `{previous}`) |
| `async` | Background execution; default from `config.json` |
| `agent` | Builtin or custom agent name |
| `task` / `tasks` / `chain` | Work specification |
| Budgets | Turn, tool, usage, spawn-per-session limits |
| `acceptance` | Criteria, verify commands, review hooks (`api/delegation.ts` schema) |

**Modes:**

- **Single** — one agent, one task, foreground or async.
- **Parallel** — multiple tasks (same or different agents); concurrency via `parallel-utils` semaphore.
- **Chain** — sequential steps; outputs feed `{previous}` in later prompts; validation in `chain-validation.ts`.

Toggle async via tool param or `~/.pi/agent/extensions/subagent/config.json` (`asyncByDefault`, `forceTopLevelAsync`).

## Builtin agents

Shipped roles (README): `scout`, `researcher`, `planner`, `worker`, `reviewer`, `context-builder`, `oracle`, `delegate`. Each has prompt/skills in `agents/` and can be overridden via settings `subagents.agentOverrides`.

## Background / async subsystem

- **Async job tracker** — `runs/background/async-job-tracker.ts`
- **Result watcher** — polls artifact dirs, dedupes completions
- **Control channel** — steer/stop/timeout via filesystem inboxes (`control-channel.ts`)
- **Scheduled runs** — cron-like scheduling (`scheduled-runs.ts`)
- **Fleet view** — TUI list of active async runs (`fleet-view.ts`, `tui/fleet.ts`)
- **Wait tool** — parent can block on background completion (`wait-tool.ts`)
- **Stale run reconciler** — recovers orphaned runs after supervisor crash

Artifacts under configurable dirs (`RESULTS_DIR`, `ASYNC_DIR`); session roots derived from parent session file (`getSubagentSessionRoot`).

## Capability and security

- **Capability ceiling** — encoded env token; intersects parent/child ceilings; can deny extensions and restrict agents/tools (`capability-ceiling.ts`).
- **Recursion guard** — depth from env; fanout-child extension for parallel child orchestration inside a child.
- **Completion guard** — detects unexpected file mutation when agent profile is read-only.
- **Acceptance framework** — post-run criteria, shell verify commands, optional reviewer agent (`acceptance.ts`).

Not a security sandbox: child Pi with Bash and user credentials has full user power.

## Extension integration

Exported subpaths:

- `./delegation` — event-based request/response protocol (`prompt-template:subagent:*` events) for other extensions to spawn runs with structured acceptance and budgets.
- `./background-work` — enqueue background work API.
- `./capability-ceiling` — ceiling encode/decode for hosts.
- `./preflight` — setup validation.

RPC bridge in `extension/rpc.ts`; intercom bridge for cross-session messaging (`intercom/`).

## UI

- Slash commands: `/subagents`, agent selector, saved workflows (`slash/`).
- Widget + fleet status above/below editor.
- Markdown result renderer with expandable details.
- Watchdog-driven review loops (optional).

## Testing

Large unit suite (`test/unit/`), integration and e2e with mock Pi (`test/support/mock-pi.ts`, real session runner). Covers chains, parallel handoff, RPC, capability ceiling, steering, async recovery.

## Distinctive features (vs tintinweb)

| Feature | nicobailon | tintinweb |
|---|---|---|
| Child runtime | Pi subprocess | In-process session |
| Tool name | `subagent` | `Agent` |
| Chain DSL | Yes | No |
| Acceptance / verify | Yes | No |
| Watchdog / review loops | Yes | No |
| Delegation API for extensions | Yes | RPC via `pi.events` only |
| Print vs RPC child | JSON print mode | N/A (in-process) |
