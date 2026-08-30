# Plan: improve `pi-antigravity` from the Antigravity VS Code extension

## Status and implementation baseline

This reviewed plan is **implemented on branch
`feat/pi-antigravity-vscode-improvements`**, based directly on `origin/main` commit
`59a2c0e11f2c48f8db42cb2a0f8fe7f8a57c1052`.

The implementation started from main at or after `f1ae49c`
(`feat(pi-antigravity): let agy own native context compaction`). That mainline already
contains:

- branch-owned native conversation persistence in `lib/conversation-state.ts`;
- `.db` existence checks and missing-conversation fallback;
- isolated disposable conversations for Pi compaction/branch summaries;
- cumulative usage restoration; and
- heuristic native-context compaction markers in `lib/agy-compaction.ts`.

Do not reimplement or weaken those behaviors. The original checkout had unrelated dirty files, so implementation was isolated in a
new clean worktree rather than modifying or rebasing that checkout.

## Research performed

Inspected:

- VS Code extension `google.google-antigravity-1.1.0`:
  - `package.json` and `README.md`;
  - generated modules in `extension.js`, especially `binary_downloader.ts`,
    `server_manager.ts`, `artifact_editor_provider.ts`, `editor_state_watcher.ts`,
    `extension_api_impl.ts`, `agent_edit_manager.ts`, and `hunk_storage.ts`;
  - the embedded `jetski_cortex.proto` descriptor; and
  - `bridge.js`/webview integration boundaries.
- Installed `agy` 1.1.22, its CLI help, models, agents, stream protocol, and local state
  under `~/.gemini/antigravity-cli/`.
- `origin/main`'s current `pi-antigravity` runtime, provider, bridge, persistence,
  compaction, artifact, and test code.

The VS Code extension is not the agent runtime. It downloads and starts `agy --hub`,
embeds the hub UI in webviews, and adapts VS Code editor state, diffs, and commands to
that UI. The reusable parts are its **process-management rules, compatibility checks,
conversation summaries, artifact conventions, and safety checks**. Its hub/Connect RPC
surface is private and should not be copied.

## Implementation and live-probe record (2026-08-30)

- Baseline: scoped typecheck and 169 tests passed before changes.
- Full driver argv probe on agy 1.1.22 used the documented stream-json input/output
  flags, `--add-dir`, normalized model plus valid effort, and no `--print` or
  `--print-timeout`. Two user events separated by 17 idle seconds stayed on PID 6255,
  conversation `1aad543c-d701-4372-92f8-7ac0133f53d2`, and returned terminal
  `SUCCESS` results with `num_turns` 1 then 2.
- MCP catalog probe registered a unique loopback server, changed its one tool from an
  `alpha: string` schema to a `beta: integer` schema between driver turns, and removed
  both registration and manifest cache in `finally`. agy 1.1.22 called `initialize`
  once and `tools/list` once at process startup; turn 2 did **not** refresh the list and
  still called the old `alpha` schema. This confirms that catalog-revision process
  recycling is required rather than merely defensive.
- Public stream-json captures still expose no exact compaction boundary. Exact
  `compacted_at_step_indices` remain private hub state, so the mainline conservative
  token-drop heuristic is intentionally unchanged.
- The workstreams below were implemented together so persistent process reuse never
  ships without bridge catalog invalidation. The operational rollback remains
  `PI_ANTIGRAVITY_DRIVER=0`.
- Post-review hardening removed PATH-order bias: automatic resolution probes both PATH
  and the managed install, chooses the newest compatible stable semver, and uses an
  explicit development build only when no stable candidate is available. Cached
  successes are invalidated when a resolved path or executable file signature changes.
- Driver snapshots and `/agy doctor` now expose spawn/respawn, submitted/reused turn,
  current-process turn, recycle, last-cause, and per-cause counters. This makes an
  effort/catalog configuration that accidentally defeats persistence observable.
- The compact parameterized lifecycle suite covers every fingerprint/conversation
  mismatch plus overall timeout, active-tool stall, abort cleanup, concurrent
  serialization, and pre-result process death without creating one test fixture per
  matrix cell.

## Verified findings and decisions

| VS Code/agy finding | What is useful to Pi | Decision |
| --- | --- | --- |
| The extension validates `agy --version` with a 5-second timeout and categorizes missing binary, permission, spawn, and timeout failures. | Fail early with actionable diagnostics instead of failing during a model turn. | Add a lazy compatibility preflight and `/agy doctor`. Require the exact driver baseline we test: agy **1.1.22+**. In automatic mode probe PATH and managed candidates, then choose the newest compatible stable build instead of trusting discovery order. |
| The extension downloads and atomically updates `~/.gemini/bin/agy`, with manifest retries and checksums. | The integrity and atomicity design is sound. | **Do not port auto-download/update.** npm extensions should not silently install executables. Continue to honor `AGY_BINARY` and tell the user how to install/update. |
| `AntigravityServerManager` has a singleton start promise, bounded readiness wait, line-buffered diagnostics, and graceful-then-force shutdown. | These are good lifecycle rules for a persistent child. | Reuse the lifecycle pattern for the documented stream-json CLI driver, not the hub. |
| The extension runs `agy --hub --hub-port=…` and serves the UI through internal APIs. | It exposes more state, but only through undocumented, CSRF/auth-gated, version-coupled APIs. | **Reject hub, `agentapi`, LS RPC, and embedded web UI integration.** |
| `agy --input-format stream-json --output-format stream-json` accepts one NDJSON user event per turn and keeps a process/conversation alive across turns. | Removes one process/auth/workspace/MCP startup per user turn. | Build one lazy persistent driver per Pi runtime. |
| Live probe: two user events in one process retain the same conversation and increment `num_turns`. | Confirms the core optimization is viable. | Make persistent mode the default, with a temporary `PI_ANTIGRAVITY_DRIVER=0` operational rollback. |
| Live probe: `--print-timeout 15s` allowed turn 1, but after the budget elapsed the process accepted turn 2 without producing a result. | `--print-timeout` is not a safe per-turn deadline in driver mode. | **Omit `--print-timeout` from persistent-driver argv.** Keep Pi-owned overall/stall timers. One-shot `/usage` and rollback mode keep their existing timeout flag. |
| Live probe: selecting a normalized model such as `gemini-3.7-flash` without `--effort` returns an error; discovered model rows encode supported effort variants. | Current model normalization loses a required launch constraint. | Preserve supported/default efforts during model discovery and always resolve a valid launch effort for variant-based models. |
| The VS Code process is configured once at launch (workspace dirs, model-facing host state). | `cwd`, model, effort, agent, and mode cannot safely drift inside one CLI process. | Treat them as a process configuration fingerprint; recycle and resume when any changes. |
| agy loads MCP servers at process startup. It is not yet proven that a stream driver repeats `tools/list` on later turns. | A persistent process could retain a stale Pi skill/MCP catalog after `/reload` or tool activation changes. | Add a catalog revision to the process fingerprint and conservatively recycle between turns when it changes. Confirm behavior with a live probe before merging. |
| The extension's workspace state stores only `lastConversationId`; reset clears stale conversation/diff state. | Titles are useful, but that ownership model is weaker than Pi's branch-aware state. | Keep main's Pi branch ownership and `.db` liveness checks. Use metadata only to enrich display. |
| `cache/conversation_metadata.json` contains `Title`, `Preview`, `NumSteps`, `UpdatedAt`, `WorkspaceURIs`, and `AgentName`. | Better `/agy` status text. | Add a tolerant, read-only metadata parser. Never use this cache as liveness authority. |
| The custom artifact editor matches `**/.gemini/*/brain/**/*.md` and routes a markdown URI plus conversation ID to the hub artifact page. | Current Pi scanning misses conversation-root markdown/direct artifacts. | Include safe root-level artifacts and add local markdown/checklist preview. Do not embed the hub viewer. |
| The extension's inline diff receives **both complete original and modified contents**, hashes hunks, records resolutions, detects external edits, and falls back to read-only diff when content diverges. | Its safety invariants are valuable. | **Do not add accept/reject diffs from stream-json.** Pi does not receive authoritative pre/post snapshots; reconstructing them from tool events or Git could overwrite user changes. |
| The editor watcher debounces active editor, selection, visible ranges, document versions, and recent tabs. | Useful only with direct VS Code APIs. | **Do not port passive IDE context.** Pi is terminal-hosted and already has explicit file/tool context. |
| The extension's agent status uses `notFullyIdle` and `waitingSteps`; Escape interrupts the agent. | Status and cancellation matter. | Use driver state plus existing streamed tool activities and Pi abort signals. Do not depend on private status RPCs. |
| Embedded `CompactionInfo` has only `repeated int32 compacted_at_step_indices`, delivered through private `AgentStateUpdate.compaction_info`. | Confirms an exact boundary exists internally, but not its token counts. | Probe stream-json once. Keep main's heuristic unless a public stream event exposes the indices. Never parse private protobuf DBs. |
| agy supports `--agent`, `agy agents`, and `--mode plan|accept-edits`. | Stable CLI-level access to custom agents and plan mode. | Add validated pass-through configuration and `/agy agents`. |

## Goals

1. Reuse one healthy agy process across ordinary user turns.
2. Preserve all mainline conversation/branch/summary isolation semantics.
3. Make binary and process failures diagnosable before they waste a turn.
4. Prevent stale Pi skills/MCP tools in a persistent process.
5. Surface useful local Antigravity metadata and markdown artifacts.
6. Expose supported agent/mode controls without private APIs.
7. Keep every TUI renderer width-safe and every lifecycle path leak-free.

## Non-goals

- No `agy --hub`, Connect RPC, `agentapi`, webview, or VS Code bridge.
- No executable downloader or updater.
- No arbitrary resume/switch to conversations from the global metadata cache.
- No passive editor-selection/tab context capture.
- No inline hunk accept/reject until a documented protocol supplies authoritative
  original and modified contents.
- No direct `.db`, protobuf, JSONL transcript, or `.system_generated` scraping for
  conversation semantics.
- No replacement for agy's native subagents, tools, permissions, or MCP registry.

---

## Workstream 0 — clean baseline and protocol gates

### 0.1 Rebase and establish baseline

Before implementation:

1. Start from a clean worktree.
2. Rebase onto current `origin/main` so the compaction/persistence work above is present.
3. Run the package checks and record the clean baseline:

```bash
pnpm --filter @tian.zuo/pi-antigravity run check
pnpm --filter @tian.zuo/pi-antigravity test
```

### 0.2 Complete two bounded live probes

Add a non-published/manual probe script or document exact commands; do not make live
agy calls part of CI.

1. **Full driver argv probe**
   - Launch with `--input-format stream-json`, `--output-format stream-json`,
     `--dangerously-skip-permissions`, `--disable-slash-commands`, `--add-dir`, a
     discovered model, and a valid discovered effort.
   - Omit `--print` and `--print-timeout`.
   - Send two user lines separated by an idle period.
   - Assert same PID, same non-empty conversation ID, `num_turns` 1 then 2, and two
     terminal results.
2. **MCP catalog refresh probe**
   - Register a uniquely named temporary loopback MCP server and remove it in `finally`.
   - Count `initialize` and `tools/list` calls.
   - Change its advertised tool schema between driver turns.
   - Record whether turn 2 triggers another `tools/list` and whether the model can see
     the changed tool.
   - Regardless of the result, retain catalog-revision recycling initially; it is rare
     and is the fail-safe behavior.

Record the observed agy version and results in this file or a short research note.

### Exit criteria

- The implementation target is a clean mainline baseline.
- Driver argv and catalog behavior are reproducible and no temporary MCP registration
  remains.

---

## Workstream 1 — binary compatibility and model launch correctness

### 1.1 Add compatibility diagnostics

Add `lib/agy-diagnostics.ts`:

- `MIN_AGY_VERSION = "1.1.22"`.
- `resolveAgyBinary()` applies this policy:
  1. an explicit `AGY_BINARY` override is strict; do not silently fall back if it fails;
  2. otherwise discover both `agy` from `PATH` and the VS Code extension's existing
     managed binary at `~/.gemini/bin/agy` (or `agy.exe` on Windows);
  3. validate all distinct discovered candidates and choose the highest compatible
     stable semver, regardless of discovery order; and
  4. if no stable candidate exists, choose the highest compatible prerelease before
     accepting a `dev`/`HEAD` candidate; development builds are the final fallback.
- Candidate resolution may reuse an already installed Google-managed binary but must
  never download or modify one. Use a maintained cross-platform executable resolver.
- `checkAgyBinary(options)` runs each eligible candidate with `--version` using:
  - a 5-second timeout;
  - detached/process-tree cleanup consistent with the existing child tracker;
  - bounded stdout/stderr capture; and
  - structured failure categories: `not-found`, `permission-denied`, `timeout`,
    `spawn-failed`, `invalid-version`, `unsupported-version`.
- Cache the selected absolute path and successful result by resolution configuration,
  resolved paths, and executable size/mtime/ctime signatures. Re-resolve and re-stat on
  access so a newly installed/replaced PATH or managed binary invalidates the cached
  compatibility result automatically. `/agy doctor` also forces a refresh.
- Route **all** agy invocations through the selected path: model discovery, MCP
  registration, usage, agents, one-shot rollback, and persistent driver. Do not let
  auxiliary commands accidentally run another agy version from `PATH`.
- Development/HEAD versions may be accepted only when their output explicitly says
  `dev` or `HEAD`; malformed versions fail closed.
- Use a maintained semver package rather than a home-grown prerelease comparator.

Run this lazily before the first Antigravity child starts. Merely loading the extension
or using another provider must not add a new blocking agy call.

### 1.2 Preserve model effort capabilities

Update `lib/models.ts`:

- Extend each normalized model record with discovered `supportedEfforts` and
  `defaultEffort`.
- Merge `foo-high`, `foo-medium`, and `foo-low` rows into one Pi model without losing
  the variants.
- Use discovery order as agy's default preference; for the current catalog that makes
  Gemini default to `high` and GPT-OSS to `medium`.
- Base rows without effort suffixes remain valid with no forced effort unless a live
  validation probe proves otherwise.
- Map Pi thinking levels to the closest supported value:
  - minimal/low → low;
  - medium → medium;
  - high/xhigh/max → high;
  - if unavailable, choose the model's discovered default instead of passing an
    invalid value.
- Add effort metadata to the fallback snapshot so offline discovery behaves the same.

### 1.3 Add `/agy doctor`

Extend the existing `/agy` command with `doctor`. It performs no model inference and
reports, without secrets:

- selected binary, source, version, and selection reason;
- every discovered candidate and its version/failure category;
- minimum supported version;
- model discovery success/count and source;
- selected model plus resolved effort;
- bridge enabled/running/registered state and catalog revision;
- driver mode/state/PID/configuration, spawn/respawn count, submitted/reused turns,
  current-process turns, recycle count, and per-cause recycle counters, if started;
- current conversation ID and whether its `.db` is readable; and
- whether conversation metadata is readable.

The command should aggregate independent failures instead of stopping at the first one.
Use concise notifications in print/RPC mode and a width-safe overlay only if the existing
command notification becomes unreadable.

### Tests

Add `test/agy-diagnostics.test.ts`; update `test/models.test.ts` and
`test/agy-client.test.ts`:

- version extraction from stdout and stderr;
- explicit override, PATH, managed-binary fallback, Windows suffix, and no-download
  behavior;
- exact minimum, newer, older, malformed, dev/HEAD;
- ENOENT, EACCES, timeout, non-zero exit, bounded diagnostics;
- every auxiliary command uses the same resolved binary;
- merging effort variants and choosing fallback effort;
- full launch argv never sends `--model <variant-base>` without a valid required
  effort.

### Exit criteria

- Unsupported binaries fail before a turn with an actionable message.
- Every discovered/fallback model produces an argv combination accepted by agy 1.1.22.
- No updater/download behavior is introduced.

---

## Workstream 2 — persistent stream-json driver

### 2.1 Keep a full request contract

Do not design the driver as `submitTurn(prompt)`. It must accept the full current
request because process reuse depends on more than text.

Extend/refine `AgyTurnRequest` in `lib/agy-client.ts` with:

- existing prompt, conversation ID, model, effort, cwd, signal, timeout, inactivity
  budgets, and callbacks;
- optional `agent` and `mode`;
- a non-argv `bridgeRevision` used in the process fingerprint; and
- test seams for spawn/time where needed.

Split argument construction into explicit functions:

- `buildOneShotAgyArgs(request)` — existing rollback behavior with
  `--print <prompt>` and `--print-timeout`;
- `buildDriverAgyArgs(processConfig)` — exactly:
  - `--input-format stream-json`;
  - `--output-format stream-json`;
  - `--dangerously-skip-permissions`;
  - `--disable-slash-commands`;
  - `--add-dir <cwd>` when set;
  - `--conversation <id>` only when launching from a known persisted/resumed
    conversation;
  - resolved `--model`/`--effort`;
  - optional `--agent` and `--mode`; and
  - **no `--print` and no `--print-timeout`**.

### 2.2 Add `lib/agy-driver.ts`

Implement `AgyDriverSession` with a small explicit state machine:

- `idle` — no process yet;
- `starting` — one shared start promise prevents duplicate children;
- `ready` — process alive, no turn active;
- `running` — exactly one submitted turn owns incoming events;
- `stopping`/`dead` — no writes accepted; next submission may spawn.

Public contract:

```ts
interface AgyTurnExecutor {
  run(request: AgyTurnRequest): Promise<AgyTurnOutcome>;
  snapshot(): AgyExecutorSnapshot; // includes bounded lifecycle + cumulative counters
  close(
    reason: "recycle" | "abort" | "shutdown",
    cause?: AgyRecycleCause,
  ): Promise<void>;
}
```

Provide two implementations:

- persistent `AgyDriverSession` (default);
- one-shot executor wrapping current `runAgyTurn` when
  `PI_ANTIGRAVITY_DRIVER=0`.

`AgyDriverSession.run(request)` must:

1. Serialize calls; never put two user events in flight.
2. Ensure the binary preflight passed.
3. Reuse only when process configuration and conversation ownership match.
4. Write one NDJSON line:

   ```json
   {"event":"user","message":{"role":"user","content":"…"}}
   ```

5. Honor stream backpressure (`write()` false → await `drain`) and handle callback
   errors/EPIPE.
6. Create a fresh `AgyTurnOutcome` and callback set for each line.
7. Fold stdout events through existing `parseAgyLine`/`applyEvent` until that turn's
   next `result`.
8. Resolve the logical turn immediately on `result`, leaving the process alive.
9. Mark the process dead on later close so the next turn resumes by conversation ID.

### 2.3 Process configuration and resume rules

The process fingerprint must contain:

- resolved binary path and validated version (so replacing an executable in place
  recycles the already-running old image on the next turn);
- cwd/add-dir set;
- model;
- resolved effort;
- agent;
- mode; and
- bridge registration/catalog revision.

Conversation ID is handled separately:

- A fresh process starts without `--conversation`; `init`/`result` binds its ID.
- A reused process is valid only when the request's conversation is the bound ID.
- A restored session or respawn launches with `--conversation <known-id>`.
- A request for no conversation while the process is bound means reset/fork and must
  recycle first.
- A different conversation ID always recycles; never send a turn to the wrong mutable
  conversation.

Fingerprint changes are allowed only between logical turns. A Pi provider re-entry
while the current agy turn is blocked on a bridge tool reuses the existing
`AgyTurnController`; it must not submit or recycle anything.

### 2.4 Framing, errors, and diagnostics

- Maintain one stdout partial-line buffer across chunks.
- Accept multiple lines in one chunk and lines fragmented across chunks.
- On process close, parse a final non-empty unterminated line before deciding failure.
- Keep only a bounded stderr tail (existing 8 KiB is sufficient) and a small bounded
  lifecycle log for `/agy doctor`.
- Unknown JSON events remain non-fatal.
- Output received while no turn is active may update diagnostics but must never be
  attached to the next turn.
- If the child closes before `result`, reject with `AgySpawnError` and mark dead.
- If it closes after a settled result, do not retroactively fail that turn.
- Guard all listeners with a child generation so late events from a recycled child
  cannot settle a newer turn.

### 2.5 Timers and cancellation

Move current watchdog semantics to the active submitted turn, not the process lifetime:

- arm overall and inactivity timers only after a user line is submitted;
- re-arm inactivity on any stdout/stderr bytes;
- switch to the longer tool budget between `tool_start` and terminal tool activity;
- disarm every timer on result/error/abort;
- keep no idle timer between turns;
- on stall, kill the active process tree and throw `AgyStallError` so the existing
  bounded continuation retry can resume the known conversation;
- on Pi abort, kill the active process tree and return the existing aborted outcome;
- an abort listener from an old turn must be removed when that turn settles.

Shutdown policy, adapted from the VS Code manager:

- idle recycle: close stdin and allow a short graceful exit, then SIGTERM, then
  SIGKILL if necessary;
- active abort/stall: immediate process-tree termination;
- session shutdown: stop known agy background tasks first (existing behavior), then
  force the driver tree closed;
- always integrate with `trackAgyChild`/`untrackAgyChild` and global death hooks.

### 2.6 Runtime integration

Change `src/runtime.ts` to own an executor, not only an injected function:

- normal runtime owns one persistent executor;
- `reset`, cwd changes, model changes, branch/tree replacement, and close invalidate
  active work and close/recycle the executor as appropriate;
- fingerprint-only changes (effort/agent/mode/catalog) recycle the process but preserve
  the runtime's known conversation ID;
- existing missing-conversation fallback and stall continuation loops remain the
  authority for retry behavior;
- existing usage and conversation callbacks remain unchanged.

Preserve summary isolation from `origin/main`:

- Pi compaction/branch-summary requests use a separate runtime and executor;
- that executor must never receive the user's conversation ID;
- close it immediately after the summary turn and dispose its Effect runtime;
- a summary failure/abort must also close it;
- no summary prompt may appear in the user's persistent process.

### 2.7 Reuse observability

Keep cumulative counters on the executor rather than the child so a respawn does not
erase the evidence. Snapshot and `/agy doctor` report:

- total spawns and derived respawns;
- submitted turns, reused turns, and turns submitted to the current process;
- recycle total, last cause, and a per-cause map for binary, cwd, model, effort, agent,
  mode, bridge catalog, conversation mismatch/reset, session tree, restore, and reset;
- a bounded timestamped lifecycle tail with the cause appended to recycle entries.

Count a recycle only when a live child is actually closed; a reset before the lazy first
spawn must not look like process churn. Do not persist these counters across Pi runtime
restarts and do not put them in model-facing prompts.

### Tests

Add `test/agy-driver.test.ts` with a controllable fake child and a fake executable
integration fixture. Cover:

- two turns, one spawn, same PID/conversation;
- exact NDJSON input and no `--print`/`--print-timeout`;
- fragmented lines, coalesced lines, CRLF, and final unterminated line;
- unknown events and stderr noise;
- stdout backpressure, `drain`, EPIPE, and child error;
- process death before result versus after result;
- no idle watchdog between turns;
- overall timeout, base stall, active-tool stall, abort, and listener cleanup;
- serialized concurrent submissions;
- process fingerprint reuse and recycle for every field;
- fresh/restored/different conversation matching;
- late events from an old process generation;
- graceful close escalation and no tracked-child leak;
- rollback executor under `PI_ANTIGRAVITY_DRIVER=0`.

Update `test/runtime.test.ts` and `test/provider.test.ts` for:

- reset, cwd, model, session tree, restored state, and shutdown close the driver;
- stall retry respawns with the continuation prompt and known ID;
- bridge tool-use provider re-entry does not submit a second user event;
- isolated summaries use another executor and close it;
- regular turns after a summary remain in the original process/conversation.

### Exit criteria

- Two ordinary Pi user turns use one agy PID and one conversation.
- All lifecycle changes route the next turn to the correct conversation/workspace.
- No driver survives session shutdown.
- The kill switch restores one-shot behavior without changing provider output.

---

## Workstream 3 — bridge catalog coherence

A persistent agy process must not freeze the Pi skill/MCP catalog captured at startup.

### 3.1 Add a stable catalog revision

Update `lib/bridge.ts`:

- Build a canonical catalog from exposed tool name, description, and input schema.
- Sort tools by exposed name and recursively sort object keys before hashing/comparing;
  preserve array order because JSON Schema arrays can be semantic. Pi enumeration or
  object insertion order must not cause spurious process restarts.
- Include the dynamic `activate_skill` definition and its enum/description.
- Increment `catalogRevision` only when canonical content changes.
- Expose the current revision and whether `refreshTools()` changed it.

Update `lib/bridge-lifecycle.ts`:

- Track a registration generation that changes on successful register/teardown.
- Expose one combined process revision, e.g.
  `<registration-generation>:<catalog-revision>`.

### 3.2 Refresh before starting a turn

Reorder non-summary setup in `src/provider.ts`:

1. refresh bridge tools;
2. resolve pending bridge results from Pi context;
3. obtain the combined bridge revision;
4. call `beginStreamTurn` with that revision.

For provider re-entry into an already active controller, a changed catalog waits until
the next user turn; never kill a process that is waiting for a Pi tool result.

On a changed revision between user turns:

- gracefully recycle the driver;
- resume the same conversation ID; and
- let agy perform startup `tools/list` against the new catalog.

Model switch ordering:

- leaving Antigravity: abort/close the driver before deregistering the bridge;
- entering Antigravity: register/refresh the bridge before the first lazy driver spawn.

Direct fallback mode is unchanged: when bridge registration fails, the skill path
catalog is appended only when needed, using existing bootstrap-suffix deduplication.

### Tests

Update `test/bridge.test.ts`, `test/runtime.test.ts`, and `test/provider.test.ts`; add
`test/bridge-lifecycle.test.ts` for the lifecycle generation behavior:

- unchanged/reordered catalogs keep one revision;
- schema/description/skill changes increment it;
- registration teardown/re-register changes it;
- one new process is launched on revision change and resumes the same conversation;
- no recycle occurs during a pending bridge call;
- switch-away closes driver before bridge teardown;
- switch-back registers bridge before spawn;
- `/reload` skill changes become visible on the next agy user turn.

### Exit criteria

- A persistent process never silently serves a stale Pi skill/MCP catalog.
- Catalog churn does not contaminate or reset conversation history.

---

## Workstream 4 — conversation metadata as display enrichment

Add `lib/conversation-metadata.ts`.

### Parser and I/O rules

- Default path:
  `~/.gemini/antigravity-cli/cache/conversation_metadata.json`.
- Parse only bounded, useful fields:
  - `ID`;
  - `Title`;
  - `Preview`;
  - `NumSteps`;
  - `UpdatedAt`;
  - `WorkspaceURIs`;
  - `AgentName`.
- Validate object/array/string/number types and cap string lengths.
- Refuse an unexpectedly large cache before reading it.
- Missing file, atomic replacement races, malformed JSON, or malformed records return
  no enrichment; they never fail a model turn.
- Do not cache indefinitely. Read on `/agy`/doctor or use a short mtime-aware cache.

### Status behavior

Enhance `/agy` status with:

- title, falling back to a shortened ID;
- step count and formatted update time when valid;
- model, turns, native context estimate, process state/PID;
- configured agent/mode; and
- metadata absence only as a diagnostic note, not an error.

**Liveness remains unchanged:**

- `agyConversationExists()` checking `conversations/<id>.db` is authoritative at
  restore time;
- agy's missing-conversation error remains the runtime fallback;
- absence from metadata must never discard a valid branch-owned conversation.

Do not add a global conversation switcher. A mutable agy conversation belongs to one Pi
branch; arbitrary resume would violate main's ownership guarantees.

### Tests

Add `test/conversation-metadata.test.ts` and status formatting tests:

- real-shape fixture with capitalized field names;
- missing, malformed, oversized, partial, and wrong-type data;
- Unicode/very long titles;
- absent metadata does not affect restore;
- metadata present but `.db` absent still fails liveness;
- status output remains bounded/readable.

### Exit criteria

- `/agy` identifies the native conversation in human terms.
- Metadata cannot cause conversation loss or turn failure.

---

## Workstream 5 — markdown and direct artifact experience

The VS Code selector proves that markdown under a conversation's `brain` directory is
an intended artifact surface. Current Pi code only scans `.tempmediaStorage` and
`.user_uploaded`, so it misses direct files such as a root-level plan/report/image.

### 5.1 Expand safe discovery

Update `lib/artifacts.ts` to scan only these explicit locations:

1. regular files directly under `brain/<conversation-id>/`;
2. regular files directly under `.tempmediaStorage/`; and
3. regular files directly under `.user_uploaded/`.

Rules:

- exclude dotfiles, `*.metadata.json`, directories, sockets, and symlinks;
- do not recurse into `scratch/` or `.system_generated/` (they contain worktrees,
  transcripts, logs, and step internals rather than user-facing artifacts);
- verify the resolved path stays under the selected conversation directory;
- deduplicate by canonical absolute path;
- classify source as `conversation`, `generated`, or `uploaded`;
- add `markdown` to media types;
- keep newest-first sorting with deterministic path/name tie-breaking.

### 5.2 Add local markdown preview

Update `src/artifacts-ui.ts`:

- Keep `o` for the system default application and `r` to rescan.
- For markdown, Enter/`v` switches the same dashboard component into a read-only
  preview state; Esc returns to the list, avoiding nested overlay lifecycle problems.
- Read a bounded amount (for example 256 KiB) and show an explicit truncation marker.
- Decode with a fatal UTF-8 `TextDecoder` so corrupt input is distinguishable from valid
  replacement characters.
- Compute checklist counts from `- [ ]` and `- [x]` lines. Display exact
  `completed/total` only when the whole file was read; label counts as partial when the
  cap truncated the file.
- Render/wrap/truncate ANSI-aware so every line satisfies `visibleWidth(line) <= width`.
- Invalid UTF-8/read failures notify and return to the list without closing the
  dashboard.
- Do not interpret or execute HTML/scripts from markdown.

Do not claim parity with the hub viewer's clickable links or interactive checklist
mutation. This is a safe local read-only viewer.

### Tests

Update `test/artifacts.test.ts`; add `test/artifacts-ui.test.ts` if needed:

- root markdown/image discovery;
- metadata sidecar, scratch, system-generated, directory, and symlink exclusion;
- path containment and deterministic ordering;
- markdown media classification and checklist counts;
- bounded reads/truncation;
- narrow widths, Unicode, long filenames, and `visibleWidth <= width` on every row.

### Exit criteria

- Plans/reports stored as direct markdown artifacts are visible and readable in Pi.
- Internal state and unsafe paths are never exposed as artifacts.

---

## Workstream 6 — agent and execution-mode pass-through

### Configuration

Add to `lib/agy-client.ts` or a small runtime config module:

- `PI_ANTIGRAVITY_AGENT=<name>` → `--agent <name>`;
- `PI_ANTIGRAVITY_MODE=plan|accept-edits` → `--mode <value>`.

Validation:

- mode must be exactly `plan` or `accept-edits`; invalid values fail before spawn with
  a clear message;
- agent names are passed as a single spawn argument (never through a shell), trimmed,
  bounded, and reject NUL/empty values;
- both fields are shown by `/agy` and `/agy doctor`;
- both participate in the driver fingerprint, so changing process configuration can
  never silently reuse an incompatible child.

Add `/agy agents`:

- invoke `agy agents` with the existing bounded command runner;
- parse/list output tolerantly; an empty successful result means no custom agents;
- do not spend tokens and do not alter the current conversation.

Plan mode is the supported CLI-level approximation of the VS Code extension's
implementation-plan workflow. It does not add the extension's private accept/reject
step RPCs or inline diff controls.

### Tests

- complete one-shot and driver argv with/without agent/mode;
- invalid mode and unsafe/empty agent input;
- process recycle when profile changes;
- empty, normal, malformed, failed, and timed-out `agy agents` output.

### Exit criteria

- Users can select a configured custom agent or plan mode through documented stable
  CLI flags.
- No private VS Code workflow API is required.

---

## Workstream 7 — exact compaction boundary probe

Main already implements conservative token-drop inference. The VS Code bundle adds one
important fact: private `AgentStateUpdate.compaction_info` contains only
`compacted_at_step_indices`.

### Probe

Capture a real compaction with agy 1.1.22 under stream-json and inspect **documented
stdout events only**. Do not parse the conversation DB or private protobuf files.

### If stream-json does not expose compaction

- Keep `lib/agy-compaction.ts` unchanged except for any test/document clarification.
- Record that exact indices exist only on the private hub state stream.
- Close this workstream without a product code path.

### If stream-json exposes step indices

- Add the smallest tolerant field/event shape to `lib/events.ts`.
- Emit an exact boundary activity from `lib/reducer.ts`.
- Track a per-conversation set of observed compacted step indices to deduplicate
  repeated state snapshots.
- Append one Pi custom marker per new boundary.
- Use nearest before/after usage samples only as approximate token labels; do not claim
  that `CompactionInfo` contains token counts.
- Keep the current heuristic as fallback for agy versions/events where indices are
  absent, but suppress a heuristic marker that corresponds to an already observed
  exact boundary.
- Reset boundary/dedup state on conversation reset, fallback, model/cwd change, branch
  move, and session replacement; restore only information already persisted in the Pi
  branch.

### Tests if positive

Update `test/agy-compaction.test.ts`, `test/reducer.test.ts`, and lifecycle tests:

- exact event parsing;
- repeated/cumulative index snapshots;
- multiple compactions;
- exact-plus-heuristic deduplication;
- missing adjacent usage;
- reset/restore lifecycle;
- width-safe custom marker rendering.

### Exit criteria

- Either exact public events are implemented with deduplication, or the negative result
  is documented and the conservative mainline heuristic remains.

---

## Workstream 8 — documentation, changesets, and rollout

Update `packages/pi-antigravity/README.md`:

- requirement: agy 1.1.22+;
- persistent driver architecture and operational rollback;
- why driver mode omits `--print-timeout`;
- lifecycle/recycle rules;
- `/agy doctor`, `/agy agents`, title enrichment, and markdown artifacts;
- `PI_ANTIGRAVITY_AGENT`, `PI_ANTIGRAVITY_MODE`, and
  `PI_ANTIGRAVITY_DRIVER=0`;
- explicit non-support for hub APIs and inline accept/reject;
- corrected diagrams: one driver spans ordinary user turns, while summaries use
  disposable isolated processes.

Keep all model-facing text in `lib/prompt.ts`. Diagnostics/UI labels are user-facing,
not model-facing, but should still be centralized when repeated.

Add a changeset for every independently publishable merged phase. Do not edit package
versions or changelogs manually.

## Delivery gates and merge sequence

To prevent the eight-workstream plan from becoming all-or-nothing, use these explicit
scope gates:

- **Required core:** WS0 + WS1, WS2 + WS3 as one atomic persistence/coherence unit,
  the WS6 process arguments needed by the fingerprint, and the relevant WS8 docs and
  rollback notes. Do not ship WS2 without WS3.
- **Optional enrichment:** WS4 metadata and WS5 artifact UX are independently shippable
  follow-ups and must not block the driver core if schedule or review capacity is tight.
- **Probe-only unless positive:** WS7 ships no new parser when the public protocol has no
  exact compaction event; documenting the negative result completes the workstream.

Recommended sequence:

1. **Core gate A — WS0 + WS1:** probes, diagnostics, effort-correct argv, and binary
   selection/cache invalidation.
2. **Core gate B — WS2 + WS3:** persistent driver, runtime/summary isolation, bridge
   catalog coherence, recycle observability, and lifecycle regression suite.
3. **Core gate C — WS6 + WS8 subset:** agent/mode pass-through, kill switch, operational
   docs, changeset, and full verification. This is the minimum releasable scope.
4. **Optional gate D — WS4:** metadata status enrichment.
5. **Optional gate E — WS5:** direct/markdown artifact discovery and preview.
6. **Evidence gate F — WS7:** compaction probe; code only on a positive public-protocol
   result, otherwise retain and document the existing heuristic.
7. **Final WS8 pass:** reconcile docs and acceptance evidence for whichever optional
   gates landed.

This branch completed the optional gates too, but their completion is not a precedent
for coupling them to future driver releases. WS4 and WS5 may be reviewed or reverted
independently without weakening process persistence or bridge safety.

## Final acceptance matrix

### Continuity and isolation

- Two normal user turns: same driver PID and same agy conversation.
- Persisted reload: new PID, restored branch-owned conversation ID.
- Pi summary/compaction: different PID and fresh conversation, closed after use.
- Reset/fork/tree/cwd/model change: no turn reaches the old mutable conversation.
- Model switch away and shutdown: no driver process remains.

### Reliability

- Fragmented NDJSON, stderr noise, EPIPE, close races, backpressure, abort, overall
  timeout, tool stall, and process death are deterministic and covered.
- Stall retry resumes a known conversation and never duplicates branch bootstrap.
- No timer or abort listener remains armed while the process is idle.

### Bridge safety

- MCP/skill catalog changes are visible by the next user turn.
- A pending bridge call is never interrupted by catalog recycling.
- Bridge teardown occurs only after the driver can no longer call it.

### State safety

- Metadata is display-only.
- `.db` plus runtime fallback remain liveness authority.
- Global conversations cannot be arbitrarily attached to a Pi branch.
- Internal/scratch files and symlinks do not appear as artifacts.

### TUI safety

- Every new status, artifact, preview, and custom-entry renderer passes narrow-width and
  Unicode tests with `visibleWidth(line) <= width`.

### Verification

Run scoped checks while iterating:

```bash
pnpm --filter @tian.zuo/pi-antigravity run check
pnpm --filter @tian.zuo/pi-antigravity test
```

Before committing/pushing, run the required monorepo verification:

```bash
pnpm run typecheck
pnpm run check
pnpm test
```

Also run one manual agy 1.1.22 smoke session that records process IDs and covers:

1. two ordinary turns;
2. one bridged Pi tool call;
3. one skill/MCP catalog refresh;
4. `/agy doctor` and `/agy` status;
5. `/agy reset` followed by a fresh turn;
6. a Pi compaction/summary request; and
7. session shutdown with no surviving driver PID.
