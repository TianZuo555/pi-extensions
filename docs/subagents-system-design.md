# Proposal: an opinionated subagent system for Pi

**Status:** design notes, not an implementation plan that has been approved.

## Short version

I would build `pi-tian-subagents` as a Pi extension with a deterministic supervisor around isolated child Pi processes.

The parent Pi remains the planner. One `subagent` tool call creates one bounded **run** from one immutable **profile**. Multiple sibling tool calls give parallelism because Pi already executes sibling tools concurrently. The framework should not invent a second planner, a chain language, or a hidden autonomous team.

The first useful release should be foreground, read-oriented delegation with strong cancellation, structured handoff, usage accounting, and observability. Background runs and writing workers should come later, after branch delivery and workspace isolation are correct.

## What I am optimizing for

1. **Fresh context** — a child receives a focused task instead of the parent's entire transcript.
2. **Predictable orchestration** — the parent model decides what to delegate and how results compose.
3. **Capability control** — a profile, not a tool argument, owns model, tools, workspace, and budgets.
4. **Parallel work** — independent investigations can run concurrently without a custom batch DSL.
5. **Inspectable work** — the user can see, open, and cancel every run.
6. **Reliable handoff** — results are bounded, structured, attributable, and delivered at most once.
7. **Safe lifecycle** — no child process survives session teardown, abort, timeout, or a supervisor crash unnoticed.
8. **Honest accounting** — nested model usage is reported where Pi can account for it; limitations are visible.

## Non-goals

The initial system should not try to be:

- an open-ended society of agents;
- a chat room where agents talk to one another;
- a persistent daemon that survives Pi sessions;
- a workflow/DAG language;
- a security sandbox;
- a replacement for the parent agent's planning;
- a way for a model to grant itself more tools or a more expensive model.

A subagent process is isolation from context and lifecycle state. It is **not** a security boundary. A process with Bash and the user's credentials can still do everything those credentials permit.

## Core decisions

| Question | Recommendation |
|---|---|
| Unit of work | One tool call creates one run |
| Runtime | One child Pi process per run |
| Child protocol | Pi RPC mode over strict JSONL |
| Child lifetime | One task, then exit |
| Parallelism | Multiple sibling `subagent` calls; supervisor enforces limits |
| Composition | Parent consumes reports and launches the next run |
| Child output | A required structured `report_result` tool, with text fallback |
| Default execution | Foreground, so results and usage remain part of the tool result |
| Default capabilities | Read-oriented profiles |
| Writer isolation | Git worktree; never concurrent writers in the parent's checkout by default |
| Recursive delegation | Disabled in children |
| Project profiles | Trusted, content-hash-approved, and explicitly namespaced |
| Background completion | Automatic, exactly once, and branch-aware |
| Session transition | Cancel every active child |

## Domain model

Naming matters because “agent” otherwise means several different things.

- **Profile** — a configuration definition whose effective prompt, model, tools, workspace policy, and budgets are snapshotted for each run.
- **Run request** — the task contract supplied by the parent.
- **Run** — one execution of one profile. It has a stable id such as `sa-a13f9c2b`.
- **Supervisor** — owns scheduling, child processes, state transitions, cancellation, logs, and result delivery.
- **Report** — the bounded semantic handoff returned by the child.
- **Artifact** — a file-backed result too large or unsuitable for model context, such as a transcript or patch.
- **Workspace** — the filesystem view in which a run operates.

A run has one terminal transition:

```text
queued -> starting -> running -> completed
                            |-> blocked
                            |-> failed
                            |-> cancelled
                            `-> timed_out
```

“Foreground versus background” and “delivered versus detached” are delivery state, not run state.

## Model-facing API

### `subagent`

The primary tool should stay small:

```ts
interface SubagentInput {
  /** Qualified profile id, for example "user/scout". */
  profile: string;

  /** Objective plus the expected deliverable. */
  task: string;

  /** Optional facts the child cannot cheaply rediscover. Not parent history. */
  context?: string;

  /** Optional checks that make completion testable. */
  acceptance?: string[];

  /** Optional directory below the run workspace. No arbitrary elevation. */
  target?: string;

  /** Foreground by default. */
  mode?: "foreground" | "background";
}
```

The model must **not** be able to pass `model`, `tools`, `skills`, `workspace`, `timeout`, or `maxCost`. Those belong to the selected profile. Otherwise the capability policy is only advisory.

Recommended input bounds:

- `task`: 16 KiB;
- `context`: 32 KiB;
- at most 8 acceptance checks;
- `target`: canonicalized below the allowed workspace root.

A good task includes an objective, a concrete deliverable, constraints, relevant paths or symbols, and how to verify the answer. The tool description should explicitly discourage delegating tiny work or the user's entire request without decomposition.

### Parallel work

There should be no `tasks: []` parameter. The parent emits multiple calls in one assistant response:

```text
subagent(user/api-scout, inspect API flow)
subagent(user/db-scout, inspect persistence flow)
subagent(user/test-scout, inspect coverage)
```

Pi already preflights sibling tools and executes them concurrently. One run per call gives each task its own cancellation, renderer, usage, result, and failure boundary.

### Chaining

There should be no `{previous}` substitution or chain DSL. If a planner needs a scout result, the parent receives the scout report and makes a later planner call with the relevant facts in `context`. This keeps orchestration visible in the parent transcript and avoids silently copying an unbounded prior answer into another prompt.

### `subagent_cancel`

A small second tool is reasonable:

```ts
interface SubagentCancelInput {
  run_id: string;
  reason?: string;
}
```

It may cancel only a live run owned by the current parent session. It is not a list or polling tool. The user also gets cancellation controls in `/agents`.

There should be no model-facing status polling tool. A foreground call resolves normally; a background call reports completion automatically.

## User-facing API

### `/agents`

A TUI dashboard should show:

- id, profile, source, model, state, elapsed time, and task preview;
- queue position and active concurrency;
- latest child text/tool events;
- turns, tokens, cache use, and cost;
- report, transcript path, and artifacts;
- cancel for a running run;
- attach for a completed result that was detached from its launch branch;
- later, inspect/apply controls for worktree changes.

Non-TUI modes should return a compact textual list through Pi's normal UI notification protocol.

### Transcript rendering

The `subagent` tool row should remain compact:

```text
● scout · sa-a13f9c2b · running · 18s
  -> grep /authenticate/ in src/
  -> read src/auth/service.ts:40-130
```

Expanded rendering can show the task contract, recent tool calls, final report, usage, and artifact paths. Streaming display state must not be added repeatedly to model context.

A one-line widget is enough while work is active:

```text
2 subagents running, 1 queued · /agents
```

## Profiles

Profiles can use the same broad shape as Pi's upstream subagent example while adding explicit policy fields.

Recommended locations:

```text
<package>/profiles/*.md          built-in templates
~/.pi/agent/agents/*.md         user profiles
.pi/agents/*.md                 project profiles
```

Example:

```md
---
name: scout
description: Locate relevant code and return evidence without changing files
model: inherit
thinking: low
tools: read, grep, find, ls
workspace: shared-readonly
timeoutSeconds: 300
maxTurns: 8
contextFiles: project
---

You are a focused codebase scout.
Return the smallest useful map of the implementation.
Cite exact paths and symbols. Do not propose changes unless the task asks for them.
```

Profiles should resolve to qualified ids:

```text
builtin/scout
user/scout
project/scout
```

An unqualified name is accepted only when it is unique. A project profile must not silently shadow a user profile.

### Profile fields

At minimum:

- `name` and `description`;
- `model`: full provider/model reference or `inherit`;
- `thinking`;
- exact tool allowlist;
- optional explicit skills;
- workspace policy;
- timeout and maximum turns;
- optional soft cost budget;
- context-file policy;
- body as the role prompt.

Profiles should not be allowed to load arbitrary extensions. The supervisor owns a curated child-extension allowlist. Loading an extension is code execution, not a prompt-level capability.

### Suggested built-ins

- **scout** — read-only code discovery and evidence.
- **planner** — read-only implementation planning from explicit context.
- **reviewer** — read-oriented review; tests only in an isolated workspace.
- **worker** — mutating tools in a worktree, introduced after the read-only system is stable.

Built-ins should default to `model: inherit` rather than assuming a provider the user may not have. Users can create cheaper or stronger role-specific profiles.

## Task and result contracts

### Do not clone the parent context

The child should receive:

1. its fixed worker protocol;
2. the selected profile prompt;
3. normal project instructions if the profile allows them;
4. the explicit task, context, and acceptance checks;
5. workspace metadata and the run id.

It should not receive the parent's transcript, hidden system prompt, pending messages, or unrelated tool output. If the parent cannot state the task without its whole history, it has not produced a good delegation boundary yet.

A child task can be formatted as:

```md
# Delegated task

Run: sa-a13f9c2b
Profile: user/scout

## Objective and deliverable
...

## Supplied context
...

## Acceptance checks
- ...

## Workspace
Repository root: ...
Target: ...
```

### Structured completion

The child-only runtime extension should register a terminating `report_result` tool:

```ts
type ReportStatus = "completed" | "blocked" | "failed";

interface RunReport {
  status: ReportStatus;
  summary: string;
  evidence?: Array<{
    path: string;
    line?: number;
    detail: string;
  }>;
  changes?: Array<{
    path: string;
    summary: string;
  }>;
  checks?: Array<{
    command: string;
    status: "passed" | "failed" | "not-run";
    summary?: string;
  }>;
  questions?: string[];
  artifacts?: Array<{
    kind: "transcript" | "patch" | "log" | "file";
    path: string;
    description: string;
    sha256?: string;
  }>;
}
```

The worker prompt tells the model to call this tool alone when finished. The tool returns `terminate: true`. The supervisor captures the report from RPC tool events. If the model fails to call it, the final assistant text becomes a bounded fallback report and the run is marked `completed-unstructured` in diagnostics.

The report sent to the parent should be capped, for example at 32 KiB. Full events and transcripts remain file-backed. The parent should treat a report as a claim to verify, not proof that tests passed or changes are safe.

## Runtime architecture

```text
Parent Pi session
  |
  `- pi-tian-subagents extension
       |- profile catalog + trust decisions
       |- supervisor + bounded scheduler
       |- run registry + persistence
       |- exactly-once result delivery
       |- tool/message renderers + /agents UI
       |
       `- one child process per run
            |- pi --mode rpc
            |- controlled resource flags
            |- private run/session directory
            |- child-runtime extension
            |    |- fixed worker prompt
            |    |- report_result tool
            |    `- capability/path guards
            `- selected built-in tools and explicit skills
```

### Why a process per run

A subprocess provides:

- independent context and extension state;
- crash containment;
- an OS process tree that can be terminated;
- no accidental sharing of parent message queues or event handlers;
- straightforward stdout/stderr and transcript capture.

The startup cost is acceptable for task-sized delegation. Reusing a long-lived child saves startup time but creates hidden conversation state, stale repository assumptions, and harder recovery. If startup later becomes material, a dedicated worker host using Pi's SDK can optimize process reuse while preserving the same run protocol.

### Why RPC instead of one-shot JSON mode

Pi's upstream example demonstrates that `--mode json -p` is enough for a prototype. RPC is a better production boundary because it gives the supervisor:

- prompt acceptance responses;
- `agent_settled`, which is later and safer than treating `agent_end` as final;
- explicit abort;
- state and session statistics;
- future steering/follow-up support without changing transport;
- strict request correlation.

The reader must implement Pi's strict LF-delimited JSONL framing. It should use a UTF-8 `StringDecoder`, split only on `\n`, tolerate a trailing `\r`, and never use Node's generic `readline` framing.

### Controlled child startup

A child should start with controlled discovery, conceptually:

```text
pi --mode rpc
   --no-extensions -e <package>/child-runtime.ts
   --no-prompt-templates
   --no-themes
   --no-skills [plus explicit --skill paths]
   --no-approve
   --model <resolved profile model>
   --thinking <profile level>
   --tools <profile tools plus report_result>
   --session-dir <private run directory>
```

Normal project context files can remain enabled for profiles that request them; use `--no-context-files` for profiles that do not. Project settings, packages, and extensions should not be inherited implicitly. This also prevents the child from loading the parent subagent extension and recursively delegating.

The parent writes resolved run configuration to a private `0600` file and passes only its path and run metadata through dedicated environment variables. This avoids putting a long profile prompt or sensitive context in shell command text. Inherited parent `PI_SESSION_*` values must be scrubbed; custom variables can record parent session id, run id, profile id, and depth.

A child RPC UI request must be rejected or cancelled automatically. Children do not ask the user directly; they return `blocked` with questions so the parent can involve the user.

### Child process lifecycle

The supervisor should borrow the hardened patterns already used by `pi-background-terminals`:

- reserve concurrency before spawning;
- register a child and its cleanup scope atomically;
- use a process group on POSIX and tree termination on Windows;
- terminate with SIGTERM, then bounded SIGKILL escalation;
- capture stderr separately;
- keep bounded in-memory head/tail plus private spill logs;
- install an abnormal-parent-exit safety net;
- never retry through another executor after a child may have started.

A provider retry belongs to the child Pi session. The supervisor must not launch a second run merely because the first child exits ambiguously; writer tasks could otherwise execute side effects twice.

## Scheduling, cancellation, and budgets

Suggested defaults:

- maximum 4 active children;
- maximum 16 queued runs;
- FIFO queue with cancellation;
- profile timeout default 5 minutes;
- profile maximum turns default 8;
- bounded report and log retention;
- optional per-provider concurrency limits.

The supervisor owns state transitions. Event/render callbacks are presentation only and cannot alter lifecycle state.

Foreground abort behavior:

1. Pi aborts the tool signal.
2. The supervisor sends RPC `abort`.
3. It waits briefly for settlement.
4. It terminates the process tree if needed.
5. The tool returns a clear cancellation outcome.

A background run has no originating tool signal after the receipt is returned. It is cancelled through `subagent_cancel`, `/agents`, timeout, or session teardown.

Turn and cost limits can be enforced only at safe boundaries between provider turns. A “maximum cost” is therefore a stop-after-observed-usage policy, not a guarantee that a single provider call cannot cross the threshold.

## Foreground and background semantics

### Foreground should be the default

A foreground run keeps the `subagent` tool Promise open while streaming bounded progress through `onUpdate`. This has three important properties:

- the parent cannot accidentally use an unfinished result;
- sibling subagent calls still execute concurrently;
- the final tool result can include nested `usage`, so Pi's footer, `/session`, RPC stats, and persisted totals remain accurate.

### Background is useful but more subtle

A background call returns a run receipt after the child accepts its task. Completion later arrives as a custom follow-up message with `triggerTurn: true`. The model should be told not to poll.

Delivery needs the same linearization used by background terminals:

- if the original tool wait owns the final result, no follow-up is queued;
- if the tool has returned a background receipt, settlement queues one result by run id;
- draining removes the result before `pi.sendMessage`;
- failed delivery is re-deferred and retried on `agent_settled`;
- session shutdown clears delivery and kills the child.

Exactly one of “tool return contains final report” and “completion follow-up contains final report” may happen.

### Native usage-accounting limitation

A background run finishes after its original tool result has already been persisted. Pi currently has no documented extension API to amend that old result's `usage`, and custom completion messages do not carry nested tool usage into native session totals.

Therefore:

- foreground usage should be included in the tool result and native Pi totals;
- background usage should be tracked and displayed by `/agents` and the result renderer;
- the UI must state that native parent-session totals exclude completed background usage;
- background mode should remain optional until this trade-off is accepted or Pi exposes an accounting entry API.

The implementation should not pretend the accounting is complete.

## Session and branch correctness

Every run records:

- parent session id;
- launch leaf id;
- originating tool call id;
- profile id and content digest;
- effective cwd/workspace;
- child session/transcript path.

Foreground results naturally persist in tool-result `details` and are branch-aware.

A background completion must verify that its launch leaf is still on the active parent branch before injecting model context. If the user navigated `/tree` to another branch, the run becomes **detached**:

- keep the result in the private run store;
- notify the user without putting it into the current model context;
- show it in `/agents`;
- require an explicit “attach result to this branch” action.

This avoids a result from one line of reasoning appearing silently in another.

`/new`, `/resume`, `/fork`, `/reload`, and quit emit `session_shutdown`; all children are cancelled there. Runs do not survive session replacement in the first implementation. In-place branch navigation is handled by the launch-leaf check above.

On reload, completed history can be reconstructed from current-branch tool details and custom completion messages. A stale external run record is audit data, not permission to inject itself into a new extension instance.

## Storage

Machine-local state should live outside the repository:

```text
~/.pi/agent/subagents/
  approvals.json
  runs/<run-id>/
    changes.patch
```

Requirements:

- directories `0700`, files `0600` where supported;
- atomic metadata/result writes;
- bounded in-memory output;
- retention by age and total bytes;
- no full transcript duplicated into parent tool details;
- profile digest and effective configuration recorded for audit;
- artifact paths shown only when the file still exists.

Logs can contain source, prompts, tool arguments, command output, and secrets accidentally printed by tools. Their private permissions and retention policy are part of the security design.

## Workspace and mutation safety

### Modes

| Mode | Intended use | Policy |
|---|---|---|
| `shared-readonly` | scout/planner | Parent checkout; only non-mutating file tools; no Bash |
| `worktree` | worker/reviewer with tests | Dedicated Git worktree and branch/artifact |
| `shared-write` | explicit escape hatch | Parent checkout; serialized; prominent warning |
| `sandbox` | future hostile/remote work | Container/VM backend with its own policy |

A profile declared `shared-readonly` must fail validation if it requests `write`, `edit`, or `bash`. Bash is not read-only just because the prompt says so.

### Writers

Concurrent writers should not operate in the parent's checkout. A worktree run should record its base commit and return:

- worktree/branch location;
- changed-file summary;
- tests/checks;
- a patch or commit reference as an artifact;
- integration instructions.

Applying changes must be a separate, user-confirmed operation. The initial system should never auto-merge a worker's output merely because the child reported success.

Dirty parent repositories need an explicit policy. The safest first behavior is to refuse a worktree writer when uncommitted parent changes are required but cannot be represented in the child base. Silently starting from `HEAD` gives the worker a different codebase from the parent.

A worktree prevents accidental edit collisions. It does not prevent absolute-path access, network access, or credential access. Real hostile-code isolation requires a container/VM backend.

## Trust and security model

1. **User and built-in profiles are trusted configuration.**
2. **Project profiles are repository-controlled prompts.** Require Pi project trust plus first-use approval keyed by profile content hash. A changed profile requires approval again; a non-UI run must refuse an unapproved profile rather than approve it implicitly.
3. **No silent source override.** Qualified profile ids prevent `project/scout` from replacing `user/scout`.
4. **No implicit child extensions.** Start with `--no-extensions` and load only the package's child runtime plus an explicit trusted allowlist.
5. **No recursive delegation.** The child does not receive the `subagent` tool.
6. **No capability override in tool input.** The parent model selects a profile but cannot mutate it.
7. **No parent transcript by default.** Pass only the task contract and explicit context.
8. **No direct child UI.** Questions come back as a blocked report.
9. **Canonical paths.** Resolve symlinks and enforce workspace roots for file-oriented tools.
10. **Bound everything sent back to a model.** Full data remains in private artifacts.
11. **Treat reports as untrusted data.** The parent verifies evidence and changes before acting.

A dynamic provider registered only by a parent extension may not exist in a child started with extension discovery disabled. The initial package should either require child-resolvable models or support an explicit trusted provider-extension allowlist. It should not enable every parent extension merely to make one model available.

## Failure semantics

Separate infrastructure failures from task outcomes:

- spawn, protocol, framing, or supervisor failures are tool execution errors;
- `blocked` and `failed` reports are valid child outcomes returned to the parent;
- provider errors and retries are visible in the child transcript;
- timeout and cancellation produce explicit terminal run states;
- malformed structured output falls back to bounded final text with diagnostics;
- a child exit without `agent_settled` is failed even if some assistant text was streamed;
- stderr is diagnostic, not automatically the semantic result.

Do not infer success only from process exit code. Success requires a settled child session and either a valid report or an explicit unstructured fallback policy.

## Suggested package layout

```text
packages/pi-subagents/
  index.ts                     parent Pi extension boundary
  package.json
  profiles/
    scout.md
    planner.md
    reviewer.md
    worker.md
  src/
    domain.ts                  Profile, Run, Report, Artifact types
    profile-catalog.ts         discovery, validation, trust, digests
    supervisor.ts              scheduler and lifecycle
    rpc-child.ts               spawn, strict JSONL client, abort
    child-runtime.ts           worker prompt, guards, report_result
    result-delivery.ts         drain-once background completion
    storage.ts                 private run records and retention
    usage.ts                   nested usage aggregation
    workspaces.ts              shared/worktree policies
    prompt.ts                  task envelope and bounded parent result
    ui/
      agents.ts                /agents dashboard and detail view
      renderers.ts             tool and completion renderers
  test/
    fixtures/
```

The package can use the same scoped Effect v4 approach as `pi-background-terminals`: a session-owned `ManagedRuntime`, a supervisor service, `Deferred` settlement, scoped child cleanup, and bounded detached fibers. It should copy lifecycle ideas, not depend on another published extension's internals.

The aggregate repository would add only a one-line compatibility stub under `extensions/`; all implementation remains in `packages/pi-subagents`.

## Implementation sequence

### Phase 1 — reliable foreground delegation

- user/built-in profile discovery and validation;
- one foreground run per tool call;
- subprocess RPC transport;
- controlled child runtime with `report_result`;
- cancellation, timeout, process-tree cleanup;
- bounded streaming renderer and nested usage;
- read-oriented profiles only.

This is already useful because the parent can issue several sibling calls in parallel.

### Phase 2 — observability and project profiles

- bounded scheduler and queue;
- `/agents` dashboard, widget, transcripts, and retention;
- qualified profile ids;
- project trust plus hash approval;
- profile/model diagnostics;
- reload/session reconstruction tests.

### Phase 3 — background runs

- background receipts;
- exactly-once completion delivery;
- branch ancestry checks and detached results;
- cancel tool and UI cancellation;
- explicit separate background usage totals.

### Phase 4 — isolated writers

- Git worktree workspace;
- dirty-repository policy;
- patch/commit artifacts;
- review and user-confirmed apply flow;
- cleanup and conflict tests.

### Phase 5 — optional advanced behavior

Only after evidence that it is needed:

- steer a live child;
- resume a completed child session for one follow-up;
- sandbox/container and remote executors;
- provider-aware rate-limit scheduling;
- prompt templates for common parent-orchestrated workflows.

I would not start with recursive delegation, persistent agent pools, or a workflow DSL.

## Required invariants and tests

The design is not complete unless tests prove these properties:

1. Every accepted run launches at most one child.
2. Every run reaches at most one terminal state.
3. A foreground result and a background completion cannot both deliver the same report.
4. A settled background run is not lost if delivery races an active parent turn.
5. A background result is never injected into a branch that does not contain its launch leaf.
6. No child process tree survives abort, timeout, reload, session switch, quit, or abnormal parent exit.
7. Concurrency slots are reserved before spawn, so parallel calls cannot exceed the cap.
8. A profile cannot escalate tools, model, workspace, or budget through tool arguments.
9. Project profiles cannot shadow user profiles and cannot run without the required approval.
10. Child extension discovery cannot recursively load the parent subagent extension.
11. JSONL parsing handles chunk boundaries, split UTF-8, CRLF input, and Unicode line separators correctly.
12. Event, stdout, stderr, report, and parent-visible output all have independent bounds.
13. Foreground nested usage contributes exactly once to Pi session totals.
14. Child reports, tool events, and usage cannot be attributed to the wrong run under concurrency.
15. Worktree cleanup never deletes a user worktree or parent changes.
16. A startup failure after spawn is never retried through a second execution path.

## Main trade-offs

- **Process isolation costs startup time.** I prefer correctness and inspectability over a premature pool.
- **One task per process loses conversational continuity.** It gains reproducibility and forces explicit handoffs.
- **Foreground runs occupy a tool call.** Pi still provides sibling parallelism and accurate usage.
- **Background runs improve responsiveness.** They introduce accounting and branch-delivery complexity, so they should not be the first milestone.
- **Worktrees complicate integration.** Shared writers are worse because they make concurrent edits nondeterministic.
- **Structured reports constrain the child.** That is desirable at the handoff boundary; full prose remains available in the transcript.

## Bottom line

I would design this as a small, deterministic delegation kernel rather than an autonomous multi-agent framework:

- the parent plans;
- profiles grant fixed capabilities;
- one call creates one isolated run;
- Pi's normal parallel tool execution supplies fan-out;
- children return structured evidence;
- the supervisor owns lifecycle and exactly-once delivery;
- users retain visibility and cancellation;
- writers do not touch the parent checkout concurrently.

That gives Pi useful subagents without hiding another orchestration system inside the extension.
