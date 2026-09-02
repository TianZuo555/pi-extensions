# Background terminals implementation guide

This document describes the invariants behind `@tian.zuo/pi-background-terminals`.
The package overrides Pi's built-in `bash` model tool, adds the bounded
read-only `terminal_log_read` tool, and adds one user command, `/ps`.

## 1. Product contract

Every model shell command goes through `bash`:

1. Validate the command, working directory, yield wait, and optional hard
   timeout.
2. Resolve Bash and Pi's shell settings.
3. Spawn with no interactive stdin and capture stdout/stderr separately.
4. Wait for a bounded initial yield period (default 10 seconds; integer inputs
   are clamped to 250–30,000 ms).
5. If the process settles during that wait, return its final state and output in
   the Bash result. A non-zero exit, kill, or timeout is a tool error.
6. Otherwise return a terminal id and leave the process running.
7. When a yielded process settles, admit its final result exactly once. Results
   that settle close together share one bounded follow-up that wakes the model.

The model-facing tool result and completion message retain bounded stdout/stderr.
Quick and initial-wait TUI rows show a sanitized bounded output preview plus a
useful command title. Only a command that actually yields is presented as a
compact background-terminal row; asynchronous completion rows also stay compact.
`/ps` remains the complete invocation and human-facing output viewer.

The model has no status, list, kill, poll, or stdin tools. `terminal_log_read`
only reads one bounded page from an opaque archive ref emitted by Bash; it does
not wait for, inspect, or control a process. The user inspects and stops running
terminals with `/ps`.

A process is session-scoped. It never survives `/new`, `/resume`, `/fork`,
`/reload`, or quit.

## 2. Why override `bash`

Pi combines built-in and extension tools by name; an extension definition wins
when it registers the same name. Registering `bash` therefore replaces the
built-in execution implementation while keeping one canonical shell tool in the
model schema.

The public schema keeps built-in compatibility:

```text
command        required string
timeout        optional hard total runtime timeout in seconds
```

It adds managed-execution controls:

```text
working_dir    optional working directory
title          optional /ps label
yield_time_ms  optional initial wait; integers clamp to 250–30,000 ms
```

The override supplies its own prompt snippet because Pi does not inherit prompt
metadata from built-ins. The snippet states that every call is a fresh shell
with direct directory changes through `working_dir`. The archive reader
supplies one prompt snippet too, keeping its bounded read-only capability
discoverable without expanding the global prompt.

The custom call/result renderers show a useful bounded title and preview for
quick work, then switch to compact id/status rendering only after a real yield.
Rendering changes presentation only: the textual result still reaches the model.
Successful Bash results use `details: undefined`, which is a valid
`BashToolDetails` shape. Private full-log paths never reach model-facing output;
settled archives are addressed through opaque refs and `terminal_log_read`.

## 3. Safe fallback boundary

A fallback may only occur before it is possible for a command to have run.

`getManager()` resolves and wires the Effect service before `manager.start()`.
If that resolution fails, the broken runtime is disposed and a fresh
`createBashToolDefinition(cwd, settings)` executes the command in Pi's standard
foreground Bash implementation.

`SpawnError` also carries `fallbackSafe`. It is true only for synchronous shell
resolution or `spawn()` failures where the manager can prove no child was
created. Those errors may use the same fallback without resetting an otherwise
healthy manager. Shutdown races set it false. The result is always prefixed with
a warning that background yielding and `/ps` were unavailable.

No fallback occurs after:

- `start()` creates a child;
- spawn succeeds or emits an asynchronous error;
- a command exits non-zero;
- a hard timeout;
- an abort;
- the managed concurrency cap is reached.

Retrying after any of those points could execute arbitrary side effects twice.
A failed command is a command result, not evidence that another executor should
run it again.

## 4. Shell compatibility

The tool preserves Pi's normal Bash behavior:

- `SettingsManager` resolves trusted global/project `shellPath` and
  `shellCommandPrefix` settings.
- `getShellConfig(shellPath)` selects Bash using Pi's cross-platform rules:
  Bash on POSIX and Git Bash/MSYS/Cygwin-compatible Bash on Windows, with Pi's
  normal fallback behavior.
- `shellCommandPrefix` is prepended only to the script sent to Bash. The
  snapshot retains the exact model-supplied command.
- The child `PATH` mirrors Pi's managed-shell behavior: `<agent-dir>/bin` is
  prepended unless already present, keeping Pi-installed tools visible while
  honoring `PI_CODING_AGENT_DIR`.
- The tool reconstructs the same live session environment values:
  `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and
  `PI_REASONING_LEVEL`. Inherited stale values are removed first.

Every call spawns a fresh shell in its resolved cwd. Shell-side `cd`, variables,
and exports therefore live only for that invocation; later calls use their own
`working_dir` or the session cwd. Most shells receive the script as a `-c`
argument and have stdin ignored. Legacy WSL Bash may require a one-shot stdin
script transport; the extension writes the script and closes the pipe
immediately. Neither path provides an interactive input surface.

## 5. File layout

```text
index.ts                    Pi boundary, bash override, fallback, /ps
src/command-shape.ts        Pre-spawn guards: state-only and duplicate commands
src/domain.ts               Snapshot/status/error types
src/manager.ts              Effect service and process lifecycle
src/output.ts               Bounded head+tail stream retention
src/process-tracker.ts      Synchronous abnormal-exit process-tree safety net
src/win32-job.ts            Native named Job Object creation and membership
src/win32-child.mjs         Plain-JS pre-shell launcher that joins the job first
src/prompt.ts               Tool metadata and model-facing formatting
src/result-delivery.ts      Drain-once completion delivery map
src/runtime.ts              ManagedRuntime and Effect→Promise boundary
src/ui/output-view.ts       ANSI-safe wrapped output rendering
src/ui/ps.ts                /ps list and detail overlays
src/ui/spill-source.ts      Bounded windowed reader over a complete spill log
```

The manager owns mutable lifecycle state. Consumers receive readonly live
`TerminalSnapshot` objects whose stdout/stderr properties are getters over
`OutputBuffer`.

## 6. Domain model

A terminal moves exactly once from `running` to one final status:

```text
running ── exit 0 ─────────────────────────────► done
running ── non-zero exit / process error ──────► failed
running ── hard runtime deadline ──────────────► timed_out
running ── /ps stop / session teardown ────────► killed
```

A snapshot includes:

- stable `bt-N` id;
- exact model command, bounded title, absolute cwd, and pid;
- timestamps, optional timeout, and final exit code or signal;
- separate stdout/stderr `OutputView` values;
- bounded lifecycle/spill error text.

`OutputView` exposes:

- `head`: stable startup prefix;
- `tail`: rolling recent suffix;
- `text`: head + omission marker + tail for `/ps`;
- `totalBytes` and `truncatedBytes`;
- optional private spill-file path for the human `/ps` viewer;
- optional `archiveComplete`, true only after a clean stdio close and spill flush.
  Model output uses an opaque archive reference and the `terminal_log_read` tool.

## 7. Execution flow

`index.ts` first performs side-effect-free validation. It preserves the exact
script text and trims only to reject an empty command. Default titles remove a
common leading assignment (`D=/path;`) or directory setup (`cd /path &&`) and
middle-truncate long commands, preserving the work-bearing suffix. Filesystem
stat errors and non-directory paths are reported before manager resolution. The
public schema accepts any integer `yield_time_ms`; the manager clamps it so an
overconfident scheduling guess cannot reject the entire tool call.

Manager execution has two calls:

```text
manager.start(...)
manager.waitForSettlement(id, yield_time_ms)
```

`start` is uninterruptible between process creation and registry insertion. This
avoids an abort window where a live child exists without a manager entry or
scope. On Windows it first creates and tracks an empty named Job Object, then
starts a small launcher. The launcher joins that job before spawning the real
Bash process, so no command process can run outside the job. POSIX starts Bash
directly as before.

During the initial wait, a per-terminal subscription emits bounded progress
updates at most every 100 ms. The custom renderer shows a sanitized preview of
at most four source lines. Quick final results show at most six; yielded results
collapse to compact terminal status with `/ps`. Exceptions thrown by the display
callback are ignored; presentation cannot affect process execution.

The initial wait is abortible. Aborting it does not kill the process. The error
identifies the terminal id, and eventual settlement remains eligible for an
automatic follow-up.

The returned result has two forms:

- **Final:** status/output are returned directly, without presenting the
  manager's internal `bt-N` identity as background work, and any deferred
  completion for the tiny start→wait race is consumed. Failed, killed, and
  timed-out final states throw so Pi marks the Bash result as an error.
- **Yielded:** status is `running`, the id and captured startup output are
  returned, and later settlement becomes a follow-up.

### Pre-spawn shape guards

`src/command-shape.ts` refuses two call shapes whose failure is otherwise
invisible to the model, since neither produces an error it could learn from:

- **State-only commands.** Every segment is `cd`, `export`, or a bare
  assignment, so the command cannot outlive its own discarded shell. Checked
  immediately after the empty-command check. The error names `working_dir` and
  the `cd x && work` combination.
- **Duplicate running commands.** An identical `command` in an identical `cwd`
  is already tracked as `running`. Checked after manager resolution and before
  spawn, so the second copy never starts. A settled twin or another directory is
  a legitimate new run.

Segments split on `&&`, `||`, `;`, `|`, and newlines.
Redirects and command substitution fail open: they can escape the shell, so
they are never treated as no-ops.

## 8. Hard runtime timeout

`timeout` is independent from `yield_time_ms`:

- `yield_time_ms` controls only when the model regains control;
- `timeout` is a total process lifetime and terminates the process tree.

The accepted timeout upper bound is Node's maximum timer delay,
2,147,483,647 ms, matching Pi's built-in Bash limit. There is no default hard
timeout.

The manager installs an unref'ed timer only after the entry is registered. If
the deadline wins before a natural `exit`, it marks the entry `timed_out` and
closes the entry scope. Natural exit metadata that already won is not rewritten
merely because descendants still hold inherited output pipes open.

Every settlement and disposal path clears the timer. Session teardown clears
all timers before closing scopes so a shutdown is reported as `killed`, not as
a coincidental timeout.

## 9. Yield/settlement linearization

The most important race is:

```text
initial yield wins  <──►  process settlement wins
```

Returning both the Bash result and an automatic follow-up would duplicate the
same completion. Returning neither would lose it.

`waitForSettlement` registers a waiter token in `settlementWaiters` before
racing the terminal's `Deferred` against `Effect.sleep(yield_time_ms)`.

When settlement wins:

1. `settle` marks every registered waiter token `consumed = true`.
2. It computes the settle-hook `consumed` flag.
3. It completes the terminal `Deferred`.
4. It invokes the settle hook.
5. The Bash call returns the final snapshot.

When yield wins:

1. The timeout branch synchronously removes its waiter token.
2. It returns the still-running snapshot.
3. A later settlement sees no waiter and therefore queues a follow-up.

The synchronous token removal is the linearization point. Cleanup is also an
Effect finalizer, so an interrupted wait cannot leave stale interest that
suppresses a future completion.

There is a second defensive layer in `index.ts`: when a final snapshot is
returned, `resultDelivery.consume(id)` removes any result deferred during the
small gap between `start` and waiter registration.

## 10. Exactly-once follow-up delivery

The settle hook receives `(snapshot, consumed)`:

- `consumed = true`: the initial Bash wait or an internal kill operation is
  already returning the final state; do not queue a follow-up.
- `consumed = false`: copy the final snapshot into the drain-once delivery map.

The map is keyed by terminal id. `drain()` clears entries before delivery, so a
result can be sent only once. A failed `pi.sendMessage` call re-defers every id
from the failed batch for a later `agent_settled` retry. Interactive mode does
not write that failure through `console.error`, which would corrupt the active
TUI frame; non-TUI modes retain the diagnostic.

Every unconsumed settlement starts or slides a 1,000 ms quiet deadline while the
first result keeps one fixed 3,000 ms maximum deadline. If quiet expires while
the agent is busy, the scheduler holds that expiry without cancelling the
maximum. `agent_settled` flushes the held group when no later result arrived. A
later result instead clears the held expiry and starts its own full quiet window;
settling the agent cannot flush that newer result early. Session shutdown
cancels both deadlines before clearing the map.

The timer group detaches before delivery, so a settlement triggered during a
synchronous delivery callback starts a new group. Generation tokens make stale
callbacks harmless even if timer cancellation races. If the initial Bash wait
consumes the only deferred result during the start-to-wait race, the now-empty
group is cancelled.

Delivery uses:

```ts
pi.sendMessage(message, {
  deliverAs: "followUp",
  triggerTurn: true,
});
```

A singleton keeps the existing message content and detail shape. A batch carries
all compact terminal details in settlement order and allocates its 32 KiB
content budget across results so every terminal summary survives truncation. Its
message renderer shows one status line with the terminal count, aggregate
outcomes, and a `/ps` hint. A busy agent receives the message after its current
run settles. An idle agent is woken when the quiet window closes. No model-driven
polling is required.

## 11. Head+tail output retention

Each stdout/stderr stream has a 2 MiB in-memory cap:

```text
stable head:   256 KiB
rolling tail:  remaining 1.75 MiB
```

`OutputBuffer.push` performs these steps:

1. Send the complete decoded chunk to the spill callback before retention.
2. Fill the stable head until its budget is reached.
3. Seal the head as soon as any byte extends past that budget.
4. Append remaining bytes to the tail.
5. Evict bytes from the front of the tail until it fits its budget.
6. Cut only at UTF-8 code point boundaries.
7. Compute omitted bytes as `total - retainedHead - retainedTail`.

Bounded slices are copied so a small retained head/tail cannot pin a giant
source Buffer. Once sealed, the head never changes. This preserves startup
configuration and first errors while the tail tracks recent logs.

`OutputView.text` inserts an explicit marker when the middle was omitted:

```text
<startup head>
... 7340032 bytes omitted ...
<recent tail>
```

The marker itself is not counted against the retained-byte cap.

### Model-facing truncation

The 2 MiB view is still too large for model context. `prompt.ts` applies Pi's
truncation utilities again with smaller per-result budgets, allocating one
quarter to startup head and three quarters to recent tail.

Initial Bash result budgets:

```text
stdout: 16 KiB / 400 lines
stderr:  8 KiB / 200 lines
```

Automatic completion budgets:

```text
stdout:  8 KiB / 40 lines
stderr:  4 KiB / 20 lines
batch:  32 KiB total content
```

A multi-terminal batch divides the aggregate budget across its results and
retains each status prefix before bounded output. The truncation marker is
charged to the same per-result share, including when an artificial share is
shorter than the full marker. Every model-visible output remains bounded even if
a child is a firehose.

## 12. Spill files and backpressure

Before spawning output consumers, the manager creates a private per-session
temporary directory (`0700`). Each stream writes to a separate `0600` file from
its first byte.

Spills are capped at 256 MiB per stream. If the cap or an I/O error is reached,
the full-log pointer is cleared and a bounded `errorText` note is attached.

When `WriteStream.write()` reports backpressure, the matching child stream is
paused and resumed on `drain`. In-memory retention still receives the triggering
chunk; subsequent child output is flow-controlled by Node.

Settlement waits for spill streams to flush before publishing the final
snapshot. The flush wait is bounded so a broken filesystem cannot leave a
terminal permanently running. When the 32-entry registry prunes a settled
terminal, its scope closes first and both owned spill files are then unlinked.
Still-tracked snapshots therefore keep valid full-log paths while session disk
usage remains bounded by retained history rather than command count. Model-facing
bounded output never exposes those private paths; it emits an opaque stream
reference only while the archive exists, with its completeness and omitted byte
range. `terminal_log_read` serves at most 64 KiB per page, 256 KiB per agent
run, and 8 reads per agent run, and reports `next_offset` without polling
terminal status.

### Model-facing archive reads

`terminal_log_read` is the only model-facing path into a complete spill. It
accepts the opaque `bt-N:stdout` or `bt-N:stderr` reference emitted by Bash,
plus a byte `offset` and bounded `limit`. The manager resolves the reference
against the live session registry rather than exposing a filesystem path. Each
read returns `settled`, `complete`, the current file size, and `next_offset`;
reading a running stream is a single non-blocking snapshot, not a status or
poll operation. Pages are capped at 64 KiB, and the extension permits 256 KiB
and 8 archive reads per agent run. Both budgets are required: the byte budget
bounds full-page firehosing, and the call budget bounds a `limit: 1` polling
loop that would otherwise spend almost no bytes. Pruned entries return an
expired/unavailable error.

A byte offset chosen by the model can land inside a code point, so both window
edges are snapped to UTF-8 boundaries before decoding: leading continuation
bytes are skipped, and a trailing sequence the window cut short is excluded so
the next page starts at its lead byte. `offset` and `next_offset` describe the
snapped window, which makes paging with `next_offset` byte-exact rather than
silently inserting replacement characters at every page boundary. A window at
end of file, or one too small to hold a single code point, is returned as read
so paging always advances.

## 13. Process lifecycle and termination

Children use separate stdout/stderr pipes and no interactive stdin. On POSIX,
`detached: true` gives the child its own process group. Windows has no portable
graceful process-tree signal, so termination uses `taskkill /F /T` on the first
attempt — a non-forced `taskkill` can remove the shell while leaving
descendants alive, destroying the stable tree root before escalation can find
them. Before spawning anything, the manager creates a named Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` through Koffi. It then starts a small Node
launcher, which joins itself to that job before it is allowed to spawn Bash.
Bash and every descendant inherit membership from process creation onward;
there is no window where a fast shell can launch an untracked child before a
post-spawn assignment. Manager startup probes the complete create → launcher
join path once. If native job creation is unavailable, or an outer host Job
Object (for example a restrictive CI runner) forbids nesting, terminals degrade
to the previous direct-spawn/taskkill path without starting a command during
the probe.

Termination is:

```text
POSIX:  SIGTERM whole tree → wait up to 2 seconds → SIGKILL whole tree
Windows: taskkill /F /T whole tree → bounded close wait → forced retry if needed
bounded final close/settle wait
```

Exit metadata is recorded on Node's `exit` event, but settlement occurs on
`close` so output has reached EOF. If descendants inherit the pipes and hold
them open after the shell exits, bounded cleanup closes the entry scope and
reaps the process group — on Windows, closing the job kills the survivors and
releases the pipes they hold.

The entry scope is the single cleanup path for `/ps` stop, hard timeout,
pruning, internal kill calls, and runtime disposal.

Pi's detached-child tracker is internal and not exported. The manager therefore
registers its own synchronous Node `exit` listener while live, tracks every
spawned pid and open job until close/scope cleanup, and closes every tracked job
object followed by a best-effort process-tree SIGKILL (`taskkill /F /T` on
Windows) if an uncaught crash or emergency terminal exit bypasses
`session_shutdown`. Closed jobs are untracked immediately, so long sessions do
not retain one handle object per historical command. Runtime disposal removes
the listener and sweeps any residual pid after normal bounded teardown.

## 14. Capacity and pruning

At most eight terminals may run concurrently. Start reserves a slot
synchronously before spawning, so parallel tool calls cannot race through the
cap. Reaching the cap is an explicit error; it does not bypass management via
the foreground fallback.

The registry retains at most 32 live/settled entries for `/ps` and exposes them
newest first. When over the limit, it removes the oldest settled entries and
their spill files; running entries are never pruned. Small tombstones retain
final kill-report facts across pruning races, and a separate bounded tombstone
records that an archive ref expired so a later `terminal_log_read` reports
expiry rather than an unknown id. Tombstones hold no path and keep no file
alive; both are cleared on disposal.

## 15. `/ps` UI

The manager exposes a synchronous `TerminalReadModel` for TUI rendering:

- `list`, `get`, and `size`;
- global and per-id subscriptions;
- fire-and-forget user kill;
- settle-hook registration.

The list overlay supports selection and stopping. The detail overlay provides:

- tabs ordered `Info`, `stdout`, `stderr`, with `Info` selected by default;
- an output-free Info view containing command, cwd, PID, status, timestamps,
  timeout, exit state, stream sizes/spill paths, and lifecycle errors;
- `t`, left/right, or `h`/`l` tab switching;
- ANSI/control sanitization at render time;
- wrapped output with cached layouts keyed by `(source version, width)`;
- live tail pinning and scrollback;
- complete-log paging once retention drops bytes (below).

### Reading the complete log

The retained view answers "what did it print recently"; the user also has to be
able to read everything a command produced. As soon as a stream reports
`truncatedBytes > 0` and still owns a spill path, the detail view stops
rendering the retained buffer and renders a window over the spill file instead
(`src/ui/spill-source.ts`). Every window edge is snapped to a UTF-8 code point
boundary, and one `loading` latch serializes reads so the 1 Hz pump cannot stack
file handles.

```text
follow      tail window, ≤ 1 MiB, tracks EOF while pinned to the bottom
loadEarlier prepend 512 KiB; the bottom stays put, so scroll offsets survive
cap         at 4 MiB loaded, loadEarlier re-anchors: new window ends exactly
            where the old one began → viewer pins to the bottom
seekAfter   next window starts exactly where the current one ended → viewer
            pins to the top
```

The two exact anchors are why paging needs no line arithmetic: a re-anchored
window shares a byte boundary with the window it replaces, so reading continues
without a gap or overlap in either direction. `follow` runs only while the
viewer is *following* (bottom-pinned and untouched by backwards paging), so a
reader in history is never yanked to EOF; `G` restores following. A pruned or
unreadable spill records a bounded error and the view degrades to the retained
buffer with a note.

## 16. Session teardown

`session_shutdown` clears UI/delivery state and disposes the ManagedRuntime.
The manager finalizer runs `disposeAll`, which:

1. marks the manager disposed;
2. removes every registry entry;
3. clears every runtime timeout;
4. closes every entry scope concurrently with bounds;
5. waits for detached cleanup fibers within the shutdown bound;
6. removes the private spill directory.

After `disposeAll`, the manager scope releases the abnormal-exit tracker,
removes its process listener, and synchronously kills any residual pid. The
`disposed` check after process setup closes a child that raced with a
teardown sweep, preventing an unregistered survivor.

## 17. Required tests

The package test suite covers:

- registration of only the `bash` override plus `/ps`;
- quick completion without a duplicate follow-up;
- yielded completion with exactly one automatic delivery;
- sliding quiet and maximum-hold batching deadlines, including cancellation;
- busy-held quiet expiry, later-arrival rearming, and maximum-hold delivery;
- synchronized yielded completions sharing one follow-up;
- unchanged singleton messages and strict UTF-8 aggregate and marker budgets;
- safe pre-spawn foreground fallback;
- non-zero commands executing only once, without fallback retry;
- Pi managed-bin `PATH`, session environment, and command-prefix preservation;
- out-of-range integer yield waits reaching the manager clamp;
- bounded streaming updates during the initial wait;
- visible quick-command title/output previews versus compact genuinely yielded
  Bash/completion rows;
- fresh-shell/`working_dir` guidance and work-bearing default titles;
- pre-spawn blocking and next-run reset for state-only and duplicate commands;
- hard timeout status and tree termination;
- Bash-specific syntax on the resolved shell;
- abort leaving eventual completion deliverable;
- process-tree kill, pre-shell Windows job membership, reload-safe native FFI,
  SIGKILL escalation, and abnormal process-exit cleanup;
- session disposal, spill-directory cleanup, and per-entry pruning cleanup;
- output head stability, rolling tail, UTF-8 boundaries, and omission counts;
- complete spill capture beyond the memory cap;
- opaque archive references, bounded `terminal_log_read` pages, settled/complete
  metadata, UTF-8-exact paging of a multi-byte archive, per-run read budgets,
  and expired-entry errors;
- drain-once result delivery without direct TUI stderr writes on retry;
- `/ps` selection, default Info tab/invocation metadata, sanitization,
  wrapping, and cache behavior;
- spill-window follow/backfill/re-anchor anchoring, UTF-8 boundaries, and
  degradation when the log becomes unreadable.

Validation commands:

```bash
npm run check --workspace @tian.zuo/pi-background-terminals
npm test --workspace @tian.zuo/pi-background-terminals
npm run typecheck
npm pack --dry-run --workspace @tian.zuo/pi-background-terminals
```

The publish workflow runs both typechecks and the package test suite before its
publish loop. The prerelease Effect runtime is pinned exactly to the beta used
by those checks so a consumer install cannot float to an unverified beta.
