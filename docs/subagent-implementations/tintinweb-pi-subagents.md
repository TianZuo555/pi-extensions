# tintinweb/pi-subagents

**Package:** `@tintinweb/pi-subagents` (npm)  
**Repo:** https://github.com/tintinweb/pi-subagents  
**Role:** Pi extension — Claude Code–style sub-agents with in-process sessions, rich TUI, and optional nesting.

## Summary

The parent agent spawns children through an `Agent` tool (not `subagent`). Each child is an **in-process** Pi `AgentSession` created via `createAgentSession()` inside `agent-runner.ts`. Foreground agents block the tool until completion; background agents return an ID immediately and notify on completion. Tool names and UX intentionally mirror Claude Code: `Agent`, `get_subagent_result`, `steer_subagent`.

## Core layout

```
src/
  index.ts            # Extension factory, tool registration, UI wiring
  agent-runner.ts     # createAgentSession, runAgent, resumeAgent, steer
  agent-manager.ts    # Registry, background queue, worktree lifecycle
  agent-types.ts      # Builtin + custom agent resolution
  custom-agents.ts    # .pi/agents/*.md discovery
  nested-tools.ts     # Opt-in nested Agent tools for child agents
  child-context.ts    # Marks in-child session context
  cross-extension-rpc.ts  # pi.events RPC (spawn/stop/ping)
  schedule.ts / schedule-store.ts  # Cron/interval scheduled agents
  worktree.ts         # Git worktree isolation
  ui/                 # Widget, fleet-list, conversation-viewer, schedule menu
```

## Execution path (`runAgent`)

1. Resolve agent config from type (builtin registry + `.pi/agents/<name>.md` frontmatter).
2. Build system prompt (`prompts.ts`) with optional memory blocks, skill preload, parent append.
3. `DefaultResourceLoader` with scoped extensions/skills (`parseExtensionsSpec`, `extensionsOverride`).
4. `createAgentSession(sessionOpts)` inside `runInChildSessionContext()` — **same Node process**.
5. Forward parent `AbortSignal` to `session.abort()`.
6. Collect assistant text from session events; detect final-turn failures (`finalTurnError`).
7. Return `RunResult` with `responseText`, usage, `aborted`, `steered` flags.

**Excluded tools:** `SUBAGENT_TOOL_NAMES` (`Agent`, `get_subagent_result`, `steer_subagent`) are stripped from children by default. Opt-in nesting re-injects scoped copies via `nested-tools.ts` when `allowed_subagents` is set in frontmatter.

## AgentManager

- **Foreground** — `spawn()` calls `runAgent` directly; blocks until done.
- **Background** — queue with `maxConcurrent` (default 4); nested children do not occupy pool slots (`occupiesPoolSlot`).
- **Resume** — `resumeAgent` continues existing session file.
- **Worktree** — optional `isolation: worktree`; `createWorktree` / `cleanupWorktree` on completion.
- **Lifecycle callbacks** — `onComplete`, `onStart`, `onCompaction` for UI and events.

Agent records keyed by UUID; completed agents linger for resume and UI.

## Tools

### `Agent`

TypeBox schema (Claude Code–like fields):

- `subagent_type` — agent name (case-insensitive; unknown → general-purpose + note)
- `prompt`, `description`
- `run_in_background`
- `inherit_context` — fork parent conversation
- `resume` — session id to continue
- `schedule` — cron / interval / one-shot (forces background)
- `model` / thinking via invocation config

### `get_subagent_result`

Poll background agent status and result text.

### `steer_subagent`

Inject user message into running agent; redirects after current tool.

## Custom agents

Markdown files with YAML frontmatter:

```yaml
# .pi/agents/explore.md
tools: read, grep, glob
extensions: [mcp]
disallowed_tools: [bash]
memory: project
allowed_subagents: [explore]   # opt-in nesting
isolation: worktree
skills: [probe-skill]
model: sonnet
thinking: high
prompt_mode: replace | append
```

Discovery: `.pi/agents/`, `.agents/agents/`, global agent dirs. Fuzzy model resolution (`model-resolver.ts`) against enabled models.

## UI

- **Widget** — spinners, tool activity, token %, compaction count (`widgetMode`: `all` | `background` | `off`).
- **FleetView** — navigable list below editor; arrow keys at empty prompt; open live conversation overlay.
- **Conversation viewer** — full scrolling transcript; steer with Enter; stop with `x`.
- **Completion notifications** — styled boxes for background results; group join consolidates bursts (`group-join.ts`).
- **Schedule menu** — `/agents → Scheduled jobs`.

## Events and RPC

Lifecycle on `pi.events`:

- `subagents:created`, `started`, `completed`, `failed`, `steered`, `compacted`
- `subagents:ready` on session start (deferred to `session_start` — issue #142 fix)
- RPC: `subagents:rpc:ping`, `spawn`, `stop` with versioned reply envelopes

## Nesting

- `maxSubagentDepth` default 2 (main=0, subagent=1, grandchild=2); `0`/`1` disables nesting.
- Child gets ownership-scoped tools; can only control its own children.
- Children stopped when parent finishes; usage rolls up.

## Persistence

- Pi session files (normal `SessionManager` paths).
- Optional output transcript JSONL per agent (`output-file.ts`) under tmpdir.
- Schedule store: `<cwd>/.pi/subagent-schedules/<sessionId>.json` with PID file locking.

## Testing

Vitest: unit + e2e including print-mode runner (`test/helpers/print-mode-runner.ts`), nested delegation, fleet wiring, RPC lifecycle gating, model scope.

## Distinctive traits

- **Lowest spawn overhead** among Pi extensions (no subprocess).
- **Claude Code fidelity** in tool names and visual language.
- **Extension async loading** handled explicitly — `allowedToolNames` unset when extensions load so MCP tools register later (#125).
- **No chain DSL** — parent model orchestrates sequences.
- **No per-spawn model in tool args** beyond what frontmatter and `enabledModels` scope allow.
