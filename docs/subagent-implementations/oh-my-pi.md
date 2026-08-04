# pi-tian-subagents — implementation handoff informed by oh-my-pi

**Status:** approved implementation handoff  
**Package:** `pi-tian-subagents` (`packages/pi-subagents`)  
**Reference implementation:** [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), checked at `003bb5548c7c1e759336e264305790de435708d1`  
**Local Pi version checked:** `@earendil-works/pi-coding-agent` 0.80.10  
**Supersedes:** the earlier proposal in this file; update `../subagent-tech-decision.md` where this handoff changes a locked decision

## Objective

Improve the shipped subagent system without importing oh-my-pi's core-only machinery.
The implementation must remain a small deterministic supervisor:

- the parent remains the planner;
- one accepted run starts at most one child process;
- profiles continue to own model, tools, workspace, and budgets;
- children remain non-recursive;
- every child result has a bounded text representation;
- writer output is preserved before an isolated worktree is removed;
- applying writer changes to the parent checkout remains an explicit,
  user-confirmed operation.

Implement the **Required work** below in order. The **Deferred work** is explicitly
out of scope for this change.

## Verified corrections to the previous plan

These facts were checked against the installed Pi 0.80.10 documentation/source and
oh-my-pi `main`.

1. **A real child result tool is portable.** `--no-extensions` disables extension
   discovery but still permits explicit `-e` paths. Pi documents this exact form:

   ```bash
   pi --no-extensions -e ./child-runtime.ts
   ```

   Therefore, do not use trailing-JSON extraction as the primary structured-output
   mechanism. Explicitly load a package-owned child runtime that registers a
   terminating `report_result` tool.

2. **Do not use RPC `steer` after `agent_settled` for retries.** `steer` queues a
   message for an already-running agent; it does not start a new idle turn. A retry
   after settlement would require `prompt`. oh-my-pi's yield reminder ladder also
   calls `session.prompt(...)`, not `steer`.

3. **RPC exposes enough events for richer supervision.** In addition to
   `agent_settled`, it exposes `turn_start`, `turn_end`, tool arguments, tool
   updates, and final tool results. Use these events rather than post-run
   `usage.turns` when enforcing a live turn budget.

4. **Automatic patch application is a policy change, not cleanup.** The existing
   design requires user-confirmed integration. Preserve that rule. Generate
   recovery artifacts automatically; apply them only through an explicit confirmed
   action.

## Required work

### R0 — Repair current lifecycle correctness

Do this before adding features.

#### R0.1 Exactly-once background completion

Current risk:

- `SubagentSupervisor.startBackground()` both stores a pending result and invokes
  `onBackgroundComplete`;
- `index.ts` immediately sends from that callback;
- a later parent `agent_settled` drains the same pending result and can send it
  again.

Replace this with one delivery state machine/ownership path. It must support:

- immediate delivery when completion occurs while the parent can accept it;
- deferred retry when delivery cannot be performed;
- claiming/removing a run before send so one result cannot be delivered twice;
- restoring it only when the send itself fails;
- clearing pending state during session teardown.

Do not treat a `Map.set()` followed by two independent send paths as exactly-once.
Add a regression test that installs the completion handler, observes completion,
then simulates the later drain/settle path and proves only one delivery occurs.

#### R0.2 Never discard worktree output

Current `cleanupWorktree()` can lose work in two cases:

- a child creates commits, leaving a clean worktree; status is empty, so the
  worktree is removed without preserving the detached commits;
- branch/commit creation throws; the catch force-removes the worktree and reports
  no changes.

Refactor finalization around `baseSha` and current `HEAD`, not only porcelain
status:

1. Detect both committed changes (`HEAD !== baseSha`) and uncommitted/untracked
   changes.
2. Preserve all changes on the run branch. If there are dirty changes, commit them
   with a deterministic local identity supplied to Git so missing global
   `user.name`/`user.email` does not destroy the result.
3. If durable branch creation fails, retain the worktree and return its recovery
   path plus an error. Never force-remove the only remaining copy of the work.
4. Remove the worktree only after either:
   - it is confirmed unchanged from the baseline, or
   - the changes are durably reachable from the reported branch (and, after R3,
     the patch artifact is written).
5. Ensure exceptional child exits cannot bypass worktree finalization or leak an
   unreported worktree.

Add tests for:

- dirty uncommitted changes;
- child-created commits with a clean status;
- missing Git user configuration;
- simulated branch/commit failure retaining a recovery worktree;
- no-change cleanup.

### R1 — Real structured handoff via a child runtime

This replaces the ADR's "assistant text only" decision while retaining text as a
fallback.

#### R1.1 Fixed report contract

Add a package-owned child extension, for example
`packages/pi-subagents/lib/child-runtime.ts`, that registers `report_result`.
Use a fixed contract rather than an arbitrary caller-provided JSON Schema:

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

Requirements:

- define the tool parameters with TypeBox; use Pi's Google-compatible enum helper
  where needed;
- return the validated report in tool-result `details`;
- return `terminate: true`;
- tell the model to call `report_result` alone as its final action;
- bound all strings/arrays in the schema and bound the parent-visible rendering;
- do not add `outputSchema` to the model-facing parent tool in this change.

#### R1.2 Controlled child loading

Spawn children with discovery still disabled, but explicitly load only the trusted
child runtime:

```text
--no-extensions -e <absolute-package-path>/lib/child-runtime.ts
```

Append `report_result` to the active `--tools` list. Do not enable user or project
extensions.

#### R1.3 Parent capture and fallback

Extend `rpc-child.ts` to capture the final successful `tool_execution_end` event
for `report_result`, including its `result.details`. Wait for `agent_settled` as
before.

Result policy:

1. A valid captured `RunReport` is the semantic result.
2. Render a bounded text form for the parent tool content.
3. Preserve the structured value in `SubagentRunResult` and
   `SubagentToolDetails` for rendering, tests, and future automation.
4. If the model never calls `report_result`, fall back to bounded
   `get_last_assistant_text` and mark diagnostics as unstructured.
5. Do not add a retry ladder in the first implementation. A missing report must not
   silently spend three extra model calls.
6. A report whose semantic status is `blocked` or `failed` is a valid structured
   child outcome; distinguish it from spawn/RPC infrastructure failure.

Add fake-RPC tests for valid structured completion, blocked/failed reports,
malformed details, text fallback, and report-size bounds.

### R2 — Profile-owned live turn budget

Implement the useful portion of the proposed governance work.

- Add profile frontmatter `maxTurns` with a small default consistent with the
  original design (default `8`).
- Allow the existing trusted settings override mechanism to override it.
- Validate it as a positive bounded integer during profile loading.
- Count live RPC turn events in `rpc-child.ts`; do not wait for final
  `get_session_stats` and then claim the run was limited.
- Abort through the existing RPC abort/termination path when the observed soft
  limit is exhausted and the run has not produced its terminal report.
- Return a clear budget-exhausted diagnostic and retain partial text/structured
  output and usage.
- Document that this is a soft turn boundary: provider retries/compaction may not
  map one-to-one to `turn_start`.

Do not add recursion depth or blocked-agent settings while nested delegation is
impossible.

### R3 — Persistent patch artifact and explicit apply

Make writer delivery convenient without silently mutating the parent checkout.

#### R3.1 Patch artifact

For every changed worktree run:

- retain the branch from R0;
- generate a binary-capable patch from `baseSha` to the finalized branch so it
  includes child-created commits as well as supervisor-committed changes;
- write it atomically with private permissions to a persistent machine-local run
  artifact location under `~/.pi/agent/subagents/runs/`, not `os.tmpdir()`;
- record patch path, SHA-256, base SHA, repository root, and branch in the run
  result/details;
- preserve the branch if patch generation fails and report the failure clearly;
- never store artifacts inside the project repository.

Introduce an injectable artifact root for tests rather than writing into the real
home directory.

#### R3.2 Confirmed apply operation

Add an explicit operation such as `subagent_apply({ run_id })` (or an equivalently
clear `/agents` action) with these rules:

- it may apply only a completed run owned by the current supervisor/session;
- it requires interactive user confirmation; non-UI execution refuses;
- it reads the recorded persistent patch and verifies its SHA-256;
- it performs read-only checks before mutation:
  - reverse applies and forward does not: already applied, return success/no-op;
  - forward applies: apply once;
  - both apply or neither applies: treat as ambiguous/conflicting and do not
    mutate;
- a failed check/apply leaves the parent checkout unchanged and keeps the patch;
- record apply status so retries are auditable;
- patch application is never the default behavior of the `worker` profile.

Use Git's normal atomic apply behavior and test dirty-parent, changed-HEAD,
already-applied, conflict, ambiguous, binary, and tampered-artifact cases.

## Deferred work — do not implement now

### Batch tool

Do not add `tasks[]` in this change. Pi already runs sibling tool calls in
parallel, and the current cap is only four. A batch surface is justified later only
if observed models fail to issue sibling calls or repeated shared context is a
measured cost. If added later, prefer a separate foreground-only
`subagent_batch` tool over a boolean-discriminated overload.

### Recursion controls

Do not add `maxDepth`, `blockedAgents`, or `PI_SUBAGENT_DEPTH` until children can
actually receive a delegation tool. Dead governance configuration is not cheap
insurance; it is unused surface area.

### Persisted revive

Do not implement child-session revive. It changes the current session-owned
lifecycle and requires a separate design for durable profile snapshots, branch
ownership, usage accounting, credentials, and result delivery.

### Arbitrary output schemas and retry ladders

Do not add caller-provided schemas, tolerant trailing-JSON parsing, or three-turn
format retries. First measure compliance with the fixed terminating report tool.

## Domain/result changes

Prefer explicit types over optional untyped bags. A reasonable shape is:

```ts
interface StructuredRunReport {
  kind: "structured";
  report: RunReport;
}

interface UnstructuredRunReport {
  kind: "unstructured";
  text: string;
  diagnostic: string;
}
```

The exact internal representation may differ, but callers must be able to tell a
validated structured report from fallback text without parsing prose.

Writer recovery fields should likewise be explicit, for example:

```ts
interface WorktreeDelivery {
  repoRoot: string;
  baseSha: string;
  branch?: string;
  retainedWorktreePath?: string;
  patch?: {
    path: string;
    sha256: string;
    applyStatus: "not-applied" | "applied" | "already-applied" | "failed";
  };
  error?: string;
}
```

## Required invariants

Tests must demonstrate all of these:

1. Every accepted run launches at most one child.
2. A background result is delivered at most once.
3. A terminal result is attributed to exactly one run under concurrency.
4. Structured reports come only from validated `report_result` tool details.
5. Missing/malformed structured output falls back to bounded assistant text.
6. Turn-budget abort uses the normal termination ladder and releases concurrency.
7. No changed worktree is removed until a branch or retained recovery worktree
   makes its data durable.
8. Child-created commits are not lost.
9. Patch artifacts are private, persistent, hash-verified, and outside the repo.
10. Applying a patch requires confirmation and is idempotent.
11. A failed or ambiguous apply does not dirty the parent checkout.
12. Session teardown kills children and clears undelivered completion state.

## Documentation and release work

Update all affected documentation so it matches behavior:

- `packages/pi-subagents/README.md`;
- `../subagent-tech-decision.md` (structured handoff and explicit patch apply now
  supersede the old locked choices);
- comments that still claim children cannot load an explicit extension;
- tool descriptions and profile examples, including `maxTurns`.

This is a backward-compatible feature release plus fixes. Bump only
`pi-tian-subagents` from `0.2.4` to `0.3.0` and synchronize `package-lock.json`.
Do not commit or push; leave the working tree for review.

## Verification commands

Run at minimum:

```bash
npm test -w pi-tian-subagents
npm run typecheck
npm run check -w pi-tian-background-terminals
```

Also inspect the package tarball if a new runtime/artifact module is added:

```bash
npm run pack:check
```

## Implementation deliverable

Return a concise handoff containing:

1. files changed and major design choices;
2. tests added and exact commands/results;
3. any invariant not fully satisfied;
4. any retained worktree or recovery artifact path;
5. remaining risks or follow-up work.
