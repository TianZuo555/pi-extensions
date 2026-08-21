# pi-goal

A Codex-style persistent goal mode for the **pi coding agent**. It turns a
thread into a bounded work loop: an explicit objective is persisted in the
session, injected into each model turn, checked against evidence, and continued
when the thread settles.

Install: `npm:@tian.zuo/pi-goal` · npm package `@tian.zuo/pi-goal` · workspace
`packages/pi-goal`

## Commands

```text
/goal <objective>                    Start a goal or edit its objective in place
/goal --budget 50000 <objective>     Start/edit and set the token budget
/goal                                Show the current goal and usage
/goal edit                           Edit the objective in a prefilled editor
/goal pause                          Pause automatic continuation
/goal resume                         Resume a paused or stopped goal
/goal budget 50000                   Set the current goal's budget
/goal budget clear                   Remove the budget
/goal complete                       Manually mark it complete
/goal clear                          Remove the current goal
```

The objective should define an auditable end state, its verification surface,
and constraints. For example:

```text
/goal Reduce p95 checkout latency below 120 ms, verified by the checkout
benchmark, while keeping the correctness suite green.
```

## Model tools

Goal content is user-owned. The model receives only the lifecycle operations
it needs while working:

- `get_goal` reads the thread's objective, status, usage, and remaining budget.
- `update_goal` can mark a goal `complete` or `blocked`; objective edits,
  pause/resume, budget, and clearing remain user/runtime controlled.

Tool metadata keeps capabilities in short descriptions and field contracts in
the schema. Active-goal system guidance carries completion and blocking policy
only when relevant. Tests cap serialized metadata for both tools at 500
characters.

## Design

The implementation follows Codex's goal architecture while using pi's
extension primitives. The reference design is documented in the [Codex goal
cookbook](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
and implemented in Codex's [goal runtime](https://github.com/openai/codex/tree/main/codex-rs/ext/goal):

- **Thread-scoped persistence:** every state change is a `pi.appendEntry()`
  custom entry. The active branch reconstructs the goal after restart, fork, or
  `/tree` navigation; state is not global memory and is not sent as raw custom
  data to the model.
- **Objective at user authority:** the system prompt carries only trusted
  extension guidance (evidence audit, `update_goal` rules). The user-controlled
  objective is injected as a transient user-role message before every LLM call
  (ordinary prompts, automatic continuations, retries, and internal turns) and
  is never persisted or promoted to system/developer authority. `/goal edit`
  opens a prefilled editor; repeated `/goal <objective>` calls use the same
  in-place update path. Continuation messages carry the objective at the same
  user authority.
- **Conservative continuation:** after an active run settles, pi queues one
  follow-up goal turn only while the thread is idle and no user input is
  pending. Aggregate-run provenance (was this run a continuation?) and tool
  activity accumulate across all low-level runs of an unsettled sequence, so
  retries and compaction cannot reset them. A continuation that makes no tool
  call suppresses the next automatic continuation, preventing chat-only spin.
- **Lifecycle authority:** only the user creates or edits objectives. The model
  can inspect a goal and mark it complete/blocked; pause, resume, interruption,
  budget, and clearing belong to the user or runtime.
- **Usage accounting:** assistant and nested tool-result tokens plus turn time
  are accumulated for the goal. Crossing a token budget changes the goal to
  `budget-limited` and injects a stop-and-report steering message; lowering the
  budget below current usage during an active run also stops work via that
  steering path and aborts the run. Raising the budget above usage (or clearing
  it) makes a `budget-limited` goal active again. A provider usage/quota error
  is only terminal once the aggregate run settles without a retry, so transient
  rate limits never freeze the goal.
- **Completion accounting:** usage is persisted through the end of the turn in
  which `update_goal(complete)` executed; the model's closing response after
  that turn is not billed to the goal. The completion tool result never
  presents pre-accounting totals as final — a corrected budget report is
  steered to the model once that turn's usage is persisted.
- **In-place objective editing:** edits preserve the goal id, accumulated token
  and time usage, budget, and creation time. An active edit steers the revised
  objective into the current run without aborting it; queued continuations carry
  revision metadata so stale objective text is supplemented before the next
  model call. Paused, blocked, and usage-limited goals stay stopped; editing a
  complete or budget-limited goal reactivates it.
- **Reload parity:** after `/reload`, an active persisted goal resumes the same
  continuation behavior as startup, resume, new, and fork. (Interrupt-paused
  goals are only auto-reactivated on startup/resume, never on reload, because
  a reload can happen mid-stream.)
- **Evidence over intent:** completion guidance requires current files,
  commands, tests, benchmarks, artifacts, or research evidence before
  `update_goal` is called.

While an active goal is running, Pi's working loader reads
`Pursuing goal: <brief of the objective>` instead of the default `Working...`
message. A goal is therefore a persisted completion contract, not an unbounded
loop. It stops when it is complete, blocked under the documented audit rule,
paused, usage-limited, budget-limited, cleared, or when continuation suppression
is reached.

## Implementation note: Effect v4 runtime boundary

`pi-goal` uses **Effect v4** (pinned to `4.0.0-beta.101`, the same tested beta
as `pi-background-terminals`) for its internal orchestration:

- `lib/state.ts` and `lib/prompt.ts` stay **pure TypeScript** (domain logic,
  formatters, prompt builders) with no Effect dependency.
- `src/runtime.ts` owns all mutable orchestration state — current goal,
  continuation queued/suppressed flags, budget-steering and pending
  usage-limit/completion-report state, aggregate agent-run provenance/tool
  counts, per-turn snapshots — in a single `SynchronizedRef` behind a
  `Context.Service`. Every state transition is one serialized
  `SynchronizedRef.modify` whose pure computation may fail with a typed
  `GoalError` (`NoGoalError`, `AlreadyCompleteError`, `InvalidObjectiveError`,
  `InvalidBudgetError`, `GoalRuntimeClosedError`)
  without touching the state.
- Transitions return **directives** (`persist` / `notify` / `send`) that the
  imperative adapter in `index.ts` executes in order; the runtime itself
  never touches pi.
- All transitions are synchronous, so the whole runtime runs under
  `Runtime.runSync`; there are no fibers, so no Queue/Deferred/Scope machinery
  beyond the `ManagedRuntime`'s own scope. `session_shutdown` (quit, reload,
  session replacement) runs the runtime's `close` operation, after which every
  operation fails fast with a typed `GoalRuntimeClosedError` instead of
  mutating stale state. The runtime owns no external resources (no processes,
  files, timers, or fibers), so closing the flag is the entire disposal;
  `ManagedRuntime.dispose()` is deliberately not used because it would replace
  the typed failure with an opaque "ManagedRuntime disposed" defect.
- Synchronous TUI renderers and prompt builders stay outside the runtime.

Effect-aware tooling matches the established repository pattern: package-local
`tsconfig.json` with the `@effect/language-service` plugin, `pnpm --filter
@tian.zuo/pi-goal run check` (`tsc --noEmit -p .`), and root typecheck exclusions. The shared
`effect-tsgo patch` prepare step remains single-owned by
`pi-background-terminals`; duplicating it across workspaces races on the same
TypeScript binary during `pnpm install`.

## Tests

```bash
pnpm --filter @tian.zuo/pi-goal test
```
