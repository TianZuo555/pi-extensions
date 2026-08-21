# @tian.zuo/pi-subagents → Herdr-backed subagents (refactor plan)

Status: approved design, staged implementation.
Owner: primary agent (plan + review). Implementation delegated to `cursor-agent` via Herdr.

## Goal

Add a **Herdr pane backend** as the preferred way to run subagents, keeping the existing
`pi --mode rpc` child backend as a fallback. A subagent becomes a *recognized agent process
in its own Herdr pane* driven by `herdr agent start/prompt/wait/read`, instead of always
being a headless RPC child.

### Approved decisions

| # | Decision |
|---|---|
| 1 | **Dual backend, Herdr preferred.** Herdr when available; RPC child when not (or when a profile pins `backend: rpc`). |
| 2 | **File-based structured report.** Child writes JSON matching the existing `RunReport` schema to a supervisor-provided path and replies with only that path. |
| 3 | **Agent kind comes from profile frontmatter** (`kind:`), never from tool arguments. |
| 4 | **`herdr worktree create`** provides isolation for write-capable profiles; we keep commit + patch artifact + `subagent_apply`. |
| 5 | **Panes are kept** while the session lives (skill default); closed on `session_shutdown` and via `/agents`. |

### Non-goals

- No usage/cost telemetry for Herdr-backed runs (Herdr exposes none). See "Usage & budgets".
- No per-tool allowlist enforcement for Herdr-backed runs (only the RPC backend can enforce `--tools`).
- No `maxTurns` enforcement for Herdr-backed runs (no `turn_start` signal); wall-clock timeout only.
- No auto-approval handling: `blocked` is surfaced to the parent, never auto-answered.

## Verified Herdr CLI contract

Most commands print one JSON object on stdout: `{"id": "cli:...", "result": {...}}`.
**The `read` commands are the exception** — see "Output shapes" below.
Verified on the installed CLI (2026-08):

```bash
test "${HERDR_ENV:-}" = 1                       # precondition; never run bare `herdr`

herdr pane layout --current                     # .result.layout.{panes[],area,tab_id,workspace_id}
herdr pane split --current --direction right|down --no-focus --cwd <path> [--env K=V]
                                                # .result.pane.pane_id
herdr pane get <pane_id>                        # .result.pane.*
herdr pane process-info --pane <pane_id>        # NOTE: flag, not positional
herdr pane read <pane_id> --source recent-unwrapped --lines N
herdr pane close <pane_id>                      # positional

herdr agent start <alias> --kind <kind> --pane <pane_id> --timeout <ms> [-- <agent args>...]
herdr agent prompt <alias> <text> --wait --until idle --until done --until blocked --timeout <ms>
herdr agent wait <alias> --until working --timeout <ms>
herdr agent read <alias> --source recent-unwrapped --lines N
herdr agent get <alias>                         # .result.agent.{agent,agent_status,pane_id,agent_session?}
herdr agent send-keys <alias> esc|enter|ctrl+c
herdr agent rename <alias> <new>

herdr worktree create --cwd <repo> --branch <name> [--base <ref>] [--path <p>] [--label <t>] --no-focus
    # .result.worktree.path, .result.workspace.workspace_id, .result.root_pane.pane_id
herdr worktree remove --workspace <workspace_id> --force
herdr workspace close <workspace_id>
herdr notification show <title> --body <text> --sound none|done|request
```

Valid `--kind` values: `pi, claude, codex, gemini, cursor, devin, agy, cline, omp, mastracode,
opencode, copilot, kimi, kiro, droid, amp, grok, hermes, kilo, qodercli, maki`.
`cursor` = the `cursor-agent` CLI; the alias **`cursor-agent` is also accepted** even though it
is absent from `--help`'s possible-values list (verified: it reaches pane lookup rather than
failing kind validation). `SUPPORTED_AGENT_KINDS` must therefore include `cursor-agent`, or
normalize it to `cursor` at parse time.

### Shell-readiness detection (verified)

`agent start` requires the pane to be at an interactive shell prompt. **`pane get` cannot
detect this** — it reports `agent_status: "unknown"` for a plain shell pane forever, so polling
it would either pass instantly or hang.

Use `pane process-info --pane <id>` instead. Verified discrimination:

| Pane state | `foreground_process_group_id` vs `shell_pid` | `foreground_processes[].name` |
|---|---|---|
| Idle at prompt | **equal** (`91454` / `91454`) | `["fish"]` |
| Running a command | **differ** (`93273` / `91454`) | `["sleep"]` |

So `waitForShell(paneId)` is: poll `pane process-info --pane <id>` until
`process_info.foreground_process_group_id === process_info.shell_pid`. That is the readiness
condition; do not match on shell names (`fish`/`zsh`/`bash` vary per user).

Note `pane run <PANE_ID> <COMMAND>...` also takes a **positional** pane id, like `pane close`.

### Settled-state result shape (verified)

`agent wait` and `agent prompt --wait` return the agent object on success:
`.result.agent.agent_status` — one of `idle | working | blocked | done | unknown`. Read the
settled state from **that path**; do not invent a top-level `status` field.

Verified error codes for `HerdrApiError.code` branching:

| Code | Meaning | Backend response |
|---|---|---|
| `timeout` | `agent wait`/`prompt --wait` deadline hit | agent may still be working; `agent get` before deciding |
| `agent_prompt_stalled` | no observed state change within 5s of submit | run the one-shot recovery in §6 |
| `agent_pane_not_found` | pane id invalid/closed | fail the run, do not retry |
| `empty_agent_prompt` | prompt text was empty | programming error — never send an empty prompt |

Because an empty prompt is rejected outright, `lib/backend-herdr.ts` must guard against an
empty composed prompt before calling `agent prompt`.

### Output shapes

Three distinct shapes; `lib/herdr/cli.ts` must model all three explicitly.

| Command class | stdout | Parse mode |
|---|---|---|
| `pane split`, `pane get`, `agent start`, `agent prompt`, `agent get`, `agent wait`, `worktree create`, … | JSON `{id, result}` | `json` |
| **`agent read`, `pane read`** | **raw terminal text** (ANSI/box-drawing, no JSON envelope) | `text` |
| CLI arg rejection | plain text e.g. `unsupported interactive agent kind: notarealkind` | error |

`agent read` / `pane read` return the terminal snapshot **directly as text** — there is no
`.result.text` field. Do not attempt `JSON.parse` on their output. The wrapper exposes two
functions:

```ts
herdrJson(args: string[]): Effect<unknown, HerdrError>   // parses envelope, unwraps .result
herdrText(args: string[]): Effect<string, HerdrError>    // returns stdout verbatim
```

Because snapshots carry ANSI escapes and box-drawing characters, transcript fallback in
`lib/backend-herdr.ts` must strip ANSI (use a small regex; do not add a dependency) and trim
agent chrome before treating the text as a report. This is a further reason the file-based
report (decision 2) is primary and the transcript is only a fallback.

### Error output shapes

Two distinct failure shapes must both be handled by `lib/herdr/cli.ts`:

| Situation | stdout/stderr | Exit |
|---|---|---|
| API-level failure | JSON: `{"error":{"code":"agent_pane_not_found","message":"..."},"id":"cli:agent:start"}` | non-zero |
| CLI arg rejection | plain text, not JSON: `unsupported interactive agent kind: notarealkind` | non-zero |

Note the failure envelope is `{error, id}` at the **top level** — there is no `result` key — so
success detection must test for `.result` presence rather than assuming it exists.

So the CLI wrapper must not assume stdout is always JSON. Parse strategy: try JSON first; if
it parses and has `.error.code`, fail with that typed code (`agent_prompt_stalled`,
`agent_pane_not_found`, `timeout`, …); if it does not parse, fail with the trimmed raw text.
Never throw a bare `JSON.parse` SyntaxError at the caller. Alias grammar: `[a-z][a-z0-9_-]{0,31}` — existing run ids
(`sa-a13f9c2b`) already comply and are used verbatim as aliases.

`herdr worktree create` creates a **new workspace** whose root pane sits in a real linked git
worktree at `~/.herdr/worktrees/<repo>/<branch>` with **the branch already checked out**
(not detached, unlike our current `git worktree add --detach`).

## Target architecture

```
index.ts                      imperative pi boundary (tools, UI, hooks) — mostly unchanged
src/runtime.ts                Effect SubagentRuntime — gains backend selection
lib/supervisor.ts             orchestration: limits, run records, worktree finalize, patch apply
lib/backend.ts            NEW  SubagentBackend interface + shared BackendRunOutput
lib/backend-rpc.ts        NEW  existing runRpcChild wrapped as a backend (moved, not rewritten)
lib/backend-herdr.ts      NEW  Herdr pane backend
lib/herdr/cli.ts          NEW  Effect wrapper: exec herdr, parse JSON, typed errors
lib/herdr/capability.ts   NEW  HERDR_ENV + herdr-on-PATH detection, cached per session
lib/herdr/workspace.ts    NEW  pane split / worktree create / cleanup helpers
lib/report-file.ts        NEW  report drop path, prompt contract text, read + validate
lib/prompt.ts                 gains buildInteractivePrompt (system prompt folded in)
lib/profile-catalog.ts        parses kind / agentArgs / backend
lib/worktree.ts               finalize adapted to a pre-existing branch + external checkout
```

### `SubagentBackend` seam

`lib/backend.ts`:

```ts
export interface BackendRunInput {
  runId: string;
  profile: ProfileDefinition;
  cwd: string;              // resolved work dir (worktree checkout for worker profiles)
  prompt: string;           // task prompt (system prompt already folded in for herdr)
  modelArg?: string;        // resolved model, backend decides how to pass it
  timeoutMs: number;
  signal: AbortSignal;
  onActivity?: (activity: string) => void;
}

export interface BackendRunOutput {
  settled: boolean;
  reportText: string;
  semanticReport: ChildSemanticReport;
  usage: RunUsage;
  usageAvailable: boolean;   // NEW — false for herdr runs
  error?: string;
  exitCode?: number | null;
  budgetExhausted?: boolean;
  terminalReportReceived?: boolean;
  herdr?: { paneId: string; alias: string; workspaceId?: string; agentStatus?: string };
}

export interface SubagentBackend {
  readonly id: "rpc" | "herdr";
  run(input: BackendRunInput): Promise<BackendRunOutput>;
  cancel(runId: string, reason?: string): Promise<void>;   // herdr: esc; rpc: abort
  dispose(): Promise<void>;                                 // herdr: close created panes
}
```

**Async disposal.** `backend.dispose()` is async because the Herdr backend closes panes and
workspaces over the socket API. Therefore `SubagentSupervisor.dispose()` must be
`async dispose(): Promise<void>` and `await` it, and `SubagentRuntime.close` in `src/runtime.ts`
must await the supervisor through `Effect.promise`. Fire-and-forget (`void backend.dispose()`)
is not acceptable: `session_shutdown` would race process exit and leak helper panes.

**Model argument.** `BackendRunInput.modelArg` is optional because some agent kinds take no
`--model` flag. The RPC adapter must therefore forward `undefined` as `undefined` and
`RpcChildRunInput.modelArg` must be optional (`buildChildArgs` already guards on
`!== undefined`). Never coerce a missing model to `""` — that would emit `--model ""`.

`SubagentSupervisor.executeRun` calls `backend.run(...)` instead of `runRpcChild(...)`.
`composeRunResult` keeps its current status logic; the only additions are `usageAvailable`
and `herdr` passthrough into `SubagentRunResult` / `SubagentToolDetails`.

### Backend selection

Resolved per run in `src/runtime.ts` (`SubagentRuntime.init` builds both lazily):

1. `profile.backend === "rpc"` → RPC backend.
2. `profile.backend === "herdr"` → Herdr backend; hard error if Herdr unavailable.
3. `auto` (default): Herdr if `HERDR_ENV === "1"` **and** `herdr` resolves on PATH, else RPC.
4. `auto` + `profile.kind !== "pi"` + Herdr unavailable → fail with a clear message
   (`Profile "x" requires agent kind "codex", which needs a Herdr session`), never silently
   downgrade to a pi RPC child.

## Herdr backend run sequence

```
1. capability check (cached)                        → HerdrUnavailable error otherwise
2. resolve location
   worker/worktree profile:
     herdr worktree create --cwd <repoRoot> --branch pi-subagent-<runId> --base HEAD --no-focus
       → workspaceId, worktreePath, root_pane
     record baseSha = git rev-parse HEAD in worktreePath (before the agent runs)
   other profiles:
     herdr pane layout --current  → pick direction: width >= 120 ? right : down
     herdr pane split --current --direction <d> --no-focus --cwd <cwd>
       → paneId
3. wait for an interactive shell: poll `pane get` / `pane process-info --pane` until the pane
   is idle at a prompt (bounded, ~5s, 150ms interval)
4. herdr agent start <runId> --kind <profile.kind> --pane <paneId> --timeout 30000
      [-- ...profile.agentArgs, --model <modelArg> when the kind supports it]
   model flag: long `--model` for pi / codex / cursor; omitted for kinds without it
5. herdr agent prompt <runId> "<prompt>" --wait --until idle --until done --until blocked
      --timeout <timeoutMs>
   onActivity("prompting") → onActivity("working")
6. recovery per skill §Recovery:
   agent_prompt_stalled → `agent get` + `agent read --source visible`;
     if the prompt is staged and state is idle: `send-keys enter`,
     `wait --until working --timeout 30000`, then re-wait for settled. Exactly one retry.
7. read result
   a. read + validate the report file (lib/report-file.ts)
   b. missing/invalid → herdr agent read <runId> --source recent-unwrapped --lines 200,
      strip the echoed prompt, use as unstructured report (same fallback shape as today)
8. status mapping
   blocked  → structured report status "blocked" when the file says so, else run status
              "completed" with a `blocked` semantic note; never auto-answer
   timeout  → send-keys esc, status "timed_out"
   abort    → send-keys esc, status "cancelled"
9. keep the pane; record { paneId, alias, workspaceId } on the run record
```

### Report file contract (decision 2)

`lib/report-file.ts`:

- Path: `<artifactRoot>/runs/<runId>/report.json`, dir `0700`, file written by the child.
- Prompt suffix appended to every Herdr-backed prompt:

```
## Required handoff
When you are finished, write your final report as JSON to:
  <path>
Schema: {"status":"completed"|"blocked"|"failed","summary":string,
  "evidence":[{"path":string,"line"?:number,"detail":string}],
  "changes":[{"path":string,"summary":string}],
  "checks":[{"command":string,"status":"passed"|"failed"|"not-run","summary"?:string}],
  "questions":[string],"artifacts":[{"kind":...,"path":string,"description":string}]}
Then reply with only that path and nothing else. Do not print the JSON in the terminal.
```

- Read with a bounded size cap (256 KB), `JSON.parse`, validate with the **existing**
  `RunReportSchema` via `Check` in `lib/run-report.ts`, then `buildSemanticReport(details, ...)`.
  Zero changes to the report schema — this is why the existing rendering keeps working.
- Report files live beside `changes.patch` and are covered by existing artifact pruning.

### Prompt for interactive agents

`buildInteractivePrompt(profile, task, context, reportPath)`:
`profile.systemPrompt` (interactive CLIs have no `--append-system-prompt`) + task + context +
handoff contract. Keep the existing `buildTaskPrompt` untouched for the RPC backend.

## Profile frontmatter additions

```yaml
kind: pi            # any supported herdr kind; default pi
backend: auto       # auto | herdr | rpc
agentArgs: --plan   # string or list, passed verbatim after `--`; validated: no shell metachars
```

Validation in `lib/profile-catalog.ts`:

- `kind` must be in a `SUPPORTED_AGENT_KINDS` const (mirrors the verified `--kind` list);
  unknown kind → profile load diagnostic, profile skipped.
- `agentArgs` entries must match `/^[A-Za-z0-9_@.,:=\/+\-\[\]]+$/`; reject anything else.
- `tools` / `workspace` keep their current meaning. For Herdr-backed runs `tools` is advisory
  (stated in the prompt) — record that honestly in the README.

Built-in profile updates:

| Profile | kind | agentArgs |
|---|---|---|
| scout, planner, reviewer | `pi` | — |
| oracle | `pi` | — |
| worker | `pi` | — |

Built-ins stay on `pi` so behavior is unchanged out of the box; the docs show how to point a
user profile at `codex`/`cursor` (e.g. `kind: cursor`, `agentArgs: --plan` for a read-only reviewer).

## Worktree changes (decision 4)

`createWorktree` gains a Herdr path; `finalizeWorktree` is adapted:

- Herdr creates the branch, so `createRunBranch` must be **skipped when the branch already
  exists and points into our worktree**. New `WorktreeInfo.branchPreexisting: boolean`.
- `baseSha` is captured after `worktree create` via `git rev-parse HEAD` in the checkout.
- `workPath` still applies the parent's repo-relative subdir.
- Patch generation (`git diff --binary <baseSha>..<branch>`), artifact write, `0600`/`0700`
  modes, sha256 and `subagent_apply` confirmation flow are **unchanged**.
- Cleanup after the patch is durable: `herdr worktree remove --workspace <id> --force`
  (instead of `git worktree remove`). On finalization failure, retain the workspace and put its
  id + path in the recovery block.
- `pruneStaleWorktrees` keeps running `git worktree prune` for RPC-created worktrees.

## Usage, budgets, limits

- `RunUsage` stays; Herdr runs report `emptyUsage()` with `usageAvailable: false`.
- `SubagentSupervisor.sessionCostUsd` only accumulates when `usageAvailable` is true, so the
  soft cost warning cannot misfire on zero-cost Herdr runs.
- `/agents` and tool results show `cost: n/a` when `usageAvailable === false`.
- `MAX_CONCURRENT_RUNS = 4` and `MAX_SESSION_RUNS = 20` unchanged; concurrency now also bounds
  simultaneously open helper panes.
- `maxTurns` is documented as RPC-only. Herdr runs are bounded by `timeoutMs`.

## Pane lifecycle (decision 5)

- Track every created pane/workspace in the supervisor: `{ runId, paneId, alias, workspaceId? }`.
- Keep them while the session is alive so the user can attach and inspect.
- `/agents` dashboard: show kind, agent status (`herdr agent get`), pane id; actions
  **focus pane**, **read last 80 lines**, **close pane**.
- `session_shutdown` / `SubagentRuntime.close`: close only panes and workspaces this session
  created, best-effort, never touching user-owned resources; failures are swallowed.
- Never stop the Herdr server. Never close a pane we did not create.

## Testing

Package tests run with `node --test --experimental-strip-types`.

**Test-suite isolation (hard requirement).** `resolveBackendKind` reads ambient `HERDR_ENV`,
and built-in profiles default to `backend: auto` — so a suite running *inside* a real Herdr
session would otherwise resolve to the Herdr backend and split real panes against the user's
live server. Two guards prevent this and both are covered by tests:

1. The package `test` script sets `PI_SUBAGENTS_DISABLE_HERDR=1`, which forces
   `isHerdrAvailable()` to `false`. An explicit `setHerdrBinaryPathForTests` override still
   wins, so selection tests can exercise the herdr-available branches deterministically.
2. `SubagentBackendPool.resolve(profile, forceRpc)` — supplying the RPC-only controls
   `spawnOverride` / `skipChildRuntime` forces the RPC backend, because those are meaningless
   to an interactive agent.

Also note the fake herdr fixture shells out to a **real** `git worktree add -B`, so every
worktree test must pass an isolated `cwd`. A test that omits it mutates the actual repo.

New/changed:

| Test | Covers |
|---|---|
| `test/herdr-cli.test.ts` | JSON parse, non-zero exit, malformed output, timeout, arg building |
| `test/backend-herdr.test.ts` | Full happy path against a **fake `herdr` executable** (a node script emitting canned JSON, injected via `herdrCliOverride: { command, args }`), plus stalled-prompt recovery, timeout, cancel |
| `test/report-file.test.ts` | valid report, oversized file, invalid JSON, schema violation, missing file → transcript fallback |
| `test/profile-catalog.test.ts` | extended: `kind`/`backend`/`agentArgs` parsing, bad kind and unsafe args rejected |
| `test/backend-selection.test.ts` | selection matrix incl. non-pi kind without Herdr → error |
| `test/worktree.test.ts` | extended: pre-existing branch finalize, herdr removal command shape (stubbed) |
| existing suites | must keep passing unchanged (RPC path is moved, not rewritten) |

No test may invoke the real `herdr` binary or spawn real agents.

## Delivery phases

Each phase ends green on `npm run check -w @tian.zuo/pi-subagents` **and**
`npm test -w @tian.zuo/pi-subagents`.

1. **Seam.** `lib/backend.ts`, move RPC into `lib/backend-rpc.ts`, supervisor calls the
   interface, `usageAvailable` plumbed through domain/details. No behavior change.
2. **Profiles.** `kind` / `backend` / `agentArgs` parsing + validation + catalog tests.
3. **Herdr plumbing.** `lib/herdr/cli.ts`, `capability.ts`, `workspace.ts` + tests with the
   fake binary.
4. **Herdr backend.** `lib/backend-herdr.ts`, `lib/report-file.ts`, interactive prompt,
   recovery, cancel/timeout + tests.
5. **Worktree via Herdr.** `WorktreeInfo.branchPreexisting`, herdr create/remove, finalize
   adaptation + tests.
6. **Wiring & docs.** Backend selection in `src/runtime.ts`, `/agents` dashboard additions,
   shutdown cleanup, README rewrite, `package.json` `files` += `docs`, version bump to
   **0.4.0** (minor: new backend, backward-compatible profiles), lockfile sync.

## Constraints for the implementer

- Repo rules apply: no backward-compat shims, simplest sufficient implementation, prefer
  existing libraries.
- **Effect v4** for the new async orchestration (`Effect.gen`, typed `Data.TaggedError`,
  `Context` services) — follow `src/runtime.ts` and the other Effect packages.
- **Erasable syntax only**: no `enum`, no namespaces, no constructor parameter properties.
- Never shell out through a shell string; always `execFile`-style argv arrays.
- Never log or embed secrets in prompts; helper prompts must state read/write scope explicitly.
- Do not commit, push, or change branches in the parent checkout.
