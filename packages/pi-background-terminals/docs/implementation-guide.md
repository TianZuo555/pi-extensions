# Background terminals implementation guide

This document describes the invariants behind `@tian.zuo/pi-background-terminals`.
The package overrides Pi's built-in `bash` model tool, adds the bounded
read-only `terminal_log_read` tool, the `terminal_wait` and `terminal_stop`
control tools, and one user command, `/ps`.

## 1. Product contract

Every model shell command goes through `bash`:

1. Validate the command, working directory, yield wait, and optional hard
   timeout.
2. Resolve Bash and Pi's shell settings.
3. Spawn with no interactive stdin and capture stdout/stderr separately.
4. Wait for a bounded initial yield period (default 10 seconds; integer inputs
   are clamped to 250–300,000 ms).
5. If the process settles during that wait, return its final state and output in
   the Bash result. A non-zero exit, kill, or timeout is a tool error.
6. Otherwise return a terminal id and leave the process running.
7. When a yielded process settles, admit its final result exactly once. Results
   that settle close together share one bounded message, steered into the
   running agent at its next tool boundary or waking an idle one.

The model-facing tool result and completion message retain bounded stdout/stderr.
Quick and initial-wait TUI rows show a sanitized bounded output preview plus a
useful command title. Only a command that actually yields is presented as a
compact background-terminal row; asynchronous completion rows also stay compact.
`/ps` remains the complete invocation and human-facing output viewer.

The model has no stdin or list tools. `terminal_log_read` reads bounded views
of a terminal's complete log (whole/auto head+tail, exact page, newest tail, or
a case-insensitive line search); it never controls a process. `terminal_wait`
blocks until a listed terminal exits — or all running yielded terminals — and
returns that result itself, consuming the settlement so no completion message
follows. `terminal_stop` kills a running terminal's tree with the same consumed
settlement. A lone `sleep` command is refused while a background terminal runs
and points at `terminal_wait`. The user inspects and stops running terminals
with `/ps`; a `/ps` kill is still reported to the model, delivered with the
next user turn instead of waking an idle one.

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
yield_time_ms  optional initial wait; integers clamp to 250–300,000 ms
```

The override supplies its own prompt snippet because Pi does not inherit prompt
metadata from built-ins. The snippet states that every call is a fresh shell
with direct directory changes through `working_dir`. The archive reader
supplies one prompt snippet too, keeping its bounded read-only capability
discoverable without expanding the global prompt.

The custom call/result renderers show a useful bounded title and preview for
quick work, then switch to compact id/status rendering only after a real yield
(the `yielded` flag on the result's `details`). The collapsed render truncates;
Ctrl+O `expanded` shows the full command and the complete captured preview.
Rendering changes presentation only: the textual result still reaches the model.
Private full-log paths never reach model-facing output;
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
index.ts                    Pi boundary, bash override, tools, fallback, /ps
src/command-shape.ts        Pre-spawn guards: state-only, duplicate, plain sleep
src/constants.ts            Shared execution and output limits
src/domain.ts               Snapshot/status/error types
src/log-read.ts             Pure file reads over a spill log (page/auto/tail/search)
src/manager.ts              Effect service and process lifecycle
src/output.ts               Bounded head+tail stream retention
src/process-tracker.ts      Synchronous abnormal-exit process-tree safety net
src/win32-job.ts            Native named Job Object creation and membership
src/win32-child.mjs         Plain-JS pre-shell launcher that joins the job first
src/prompt.ts               Tool metadata, validation/errors, model-facing formatting
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

- stable `bt-<16-hex-runtime-id>-N` id, never reused across runtime recreation;
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

Cancellation is checked before initialization, after initialization, and at the
spawn boundary (after any asynchronous Windows job setup). A pre-spawn abort
never runs the command or invokes foreground fallback. Abort-related spawn
errors carry `fallbackSafe: false`, independently of the tool boundary's own
cancellation checks. Once spawned, the initial
wait is abortible. Aborting it does not kill the process. The result reports
the abort, marks the tool call unsuccessful (`isError`), and carries the live
`running` status in `details`; eventual settlement remains eligible for an
automatic follow-up.

The returned result has two forms:

- **Final:** status/output are returned directly, without presenting the
  manager's internal terminal identity as background work, and any deferred
  completion for the tiny start→wait race is consumed. Failed, killed, and
  timed-out final states return `isError: true` so Pi marks the Bash result as
  an error while the structured status still reaches the renderer.
- **Yielded:** status is `running`, the id and captured startup output are
  returned, and later settlement becomes a follow-up.

Every managed Bash result also carries `details: { id, status, yielded }`.
The renderer reads that structured state instead of parsing the model-facing
text — result text can contain status-looking words (a `killed` directory in
the cwd, an aborted wait) that would corrupt a regex-derived status.

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
- **Plain sleeps while background work runs.** A lone `sleep N` (optionally
  followed by an `echo`) while any terminal is `running && yielded` is refused
  with a pointer to `terminal_wait`: results are pushed, so the sleep cannot
  make one arrive sooner and only wastes a turn. With nothing running the same
  command executes normally.

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

`waitForSettlement` registers a waiter token in `settlementWaiters`, then
awaits the terminal's `Deferred` under `Effect.timeoutOrElse(yield_time_ms)`.

When settlement wins:

1. `settle` marks every registered waiter token `consumed = true`.
2. It computes the settle-hook `consumed` flag.
3. It completes the terminal `Deferred`.
4. It invokes the settle hook.
5. The Bash call returns the final snapshot.

When yield wins:

1. The timeout branch synchronously removes its waiter token.
2. It marks the snapshot `yielded` — the entry is now a background terminal
   (the widget counts only these, so a quick command's initial wait never
   flashes it; pruning also prefers evicting entries that never yielded).
3. It returns the still-running snapshot.
4. A later settlement sees no waiter and therefore queues a follow-up.

The synchronous token removal is the linearization point. Cleanup is also an
Effect finalizer, so an interrupted wait cannot leave stale interest that
suppresses a future completion — the interrupt path marks `yielded` the same
way, since the process genuinely became background work.

There is a second defensive layer in `index.ts`: when a final snapshot is
returned, `resultDelivery.consume(id)` removes any result deferred during the
small gap between `start` and waiter registration.

`waitForAny` and `stop` reuse the same consumed-waiter mechanism without the
`yielded` side effect: `waitForAny` registers one waiter per running target and
races their `settled` deferreds against the timeout (clamped to
1–3,600 s), while `stop` registers its waiter BEFORE triggering the detached
scope-close kill, then awaits settlement bounded by the stop timeout plus the
settle grace. Both linearize the same way — one synchronous block removes the
waiters and reads the statuses — and both remove waiters in `ensuring` so an
interrupted wait cannot suppress a later completion. A settle that lands after
removal flows to the normal follow-up path. A `stop` wait interrupted by Esc
does not cancel the kill: the teardown fiber is detached, so "termination
continues in the background" stays truthful.

## 10. Exactly-once completion delivery

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
first result keeps one fixed 3,000 ms maximum deadline. Either deadline flushes
whether or not the agent is busy: delivery is a steer, so holding a busy
agent's result back would only delay it. `agent_before_settle` (outcome
`completed`) flushes a group still inside its window immediately, so the run
that is about to end continues with the result instead of settling and waking a
separate run — which print/json mode would never do, since it exits on
settlement. Aborted or failed runs are not continued. Session shutdown cancels
both deadlines before clearing the map.

The timer group detaches before delivery, so a settlement triggered during a
synchronous delivery callback starts a new group. Generation tokens make stale
callbacks harmless even if timer cancellation races. If the initial Bash wait
consumes the only deferred result during the start-to-wait race, the now-empty
group is cancelled.

Delivery uses:

```ts
pi.sendMessage(message, {
  deliverAs: "steer",
  triggerTurn: true,
});
```

A batch whose terminals were all `killed` is a `/ps` stop the user already
watched happen; it is delivered as `{ deliverAs: "nextTurn" }` instead, so it
reaches the model with the next user turn without waking an idle agent.
`terminal_wait` and `terminal_stop` consume settlements at the waiter level
(§9) and additionally `take()` their ids out of the delivery map as a race
guard, so a result they return can never also become a message.

`followUp` would only be drained once the model stops calling tools, so a model
that keeps working would act without the result and write a final answer before
seeing it. A steer is drained after every tool batch — at a turn boundary, never
mid-stream.

A singleton keeps the existing message content and detail shape. A batch carries
all compact terminal details in settlement order and allocates its 32 KiB
content budget across results so every terminal summary survives truncation. Its
message renderer shows one status line with the terminal count, aggregate
outcomes, and a `/ps` hint. A busy agent receives the message after its current
tool batch. An idle agent is woken when the quiet window closes. No model-driven
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

Once an entry settles AND its archive flushed completely, `OutputBuffer.compact`
shrinks the in-memory copy to 64 KiB (head capped at one eighth) — the spill
file is the durable record at that point, and a settled buffer only serves the
small result/UI views. 32 retained entries therefore cannot hold hundreds of
MiB of process output hostage. Entries without a complete archive keep their
full 2 MiB view; it is the only copy.

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
directory (`0700`) under the agent state directory —
`<agent-dir>/background-terminals/session-<pid>-<random>` via `mkdtemp`. This
deliberately avoids a shared `/tmp`: a same-named directory owned by another
user would silently disable spilling, and private command output does not
belong in a world-readable location. When the spill base is (re)created, any
`session-<pid>-*` directory whose owner pid no longer exists is swept — a
crashed Pi leaves its archives behind otherwise. Each stream writes to a
separate `0600` file from its first byte.

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
range. `terminal_log_read` serves at most 64 KiB per call, 256 KiB per agent
run, and 8 reads per agent run, and reports `next_offset` without polling
terminal status.

### Model-facing archive reads

`terminal_log_read` is the only model-facing path into a complete spill. It
accepts a bare `bt-<runtime-id>-N` id (stdout) or the `id:stdout` / `id:stderr`
ref, plus `offset`, `limit`, `tail`, and `pattern`. Mode selection: `pattern`
runs a streaming case-insensitive line search over `[offset, size)` that
carries partial lines across 64 KiB chunks, formats matches as
`@<line-start-byte>: <line>` capped to 300 chars, stops collecting when the
next line would exceed `limit` bytes while `matchCount` keeps counting, and
honors the tool's AbortSignal between chunks; `tail` returns the newest
`limit` bytes; an explicit `offset` is an exact page; otherwise auto returns
the whole log when it fits or a head+tail view naming the omitted byte range.
The manager resolves the id against the live session registry rather than
exposing a filesystem path, and the pure read logic lives in `src/log-read.ts`.
Each read returns `settled`, `complete`, the current file size, `next_offset`,
and a `mode`; results are at most 64 KiB, and the extension permits 256 KiB
and 8 archive reads per agent run. Both budgets are required: the byte budget
bounds full-page firehosing, and the call budget bounds a `limit: 1` polling
loop that would otherwise spend almost no bytes. Pruned entries return an
expired/unavailable error. Every manager has a fresh random 64-bit runtime id;
refs from a previous runtime cannot alias terminals after reload/resume.

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
releases the pipes they hold. Closed pipes alone are not proof of tree exit:
redirected descendants may still be alive in the POSIX process group. Natural
settlement and explicit termination both reap that group with bounded
SIGTERM→SIGKILL escalation. A group remains in the abnormal-exit tracker until
it is gone; disposal sweeps any residual group.

The entry scope is the single cleanup path for `/ps` stop, hard timeout,
pruning, internal kill calls, and runtime disposal.

Pi's detached-child tracker is internal and not exported. The manager therefore
registers its own synchronous Node `exit` listener while live, tracks every
spawned process group and open job until confirmed tree cleanup, and closes every tracked job
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
newest first. When over the limit it prunes settled entries oldest first —
preferring entries that never yielded (quick commands that settled inside their
initial wait) so a `ls`-heavy session cannot evict a real background terminal's
archive. Running entries are never pruned. A bounded tombstone records that an
archive ref expired so a later `terminal_log_read` reports expiry rather than
an unknown id. Tombstones hold no path and keep no file alive; they are cleared
on disposal.

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
viewer is *following*. Any upward scroll, Page Up, or `g` pauses following
immediately, not just when a disk page is loaded. Retained in-memory text is
frozen while paused, so its rolling tail cannot move the reading position.
The first disk window may still load while paused; pausing before its async
read commits must not disable archive paging. If retention overflows during a
memory pause, explicit backward paging switches to the spill without requiring
`G` or a tab switch. Returning to the bottom or pressing `G` restores following.
A pruned or unreadable spill records a bounded error and the view degrades to the retained
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

- registration of the `bash` override, `terminal_log_read`, `terminal_wait`,
  `terminal_stop`, and `/ps`, including per-tool prompt-size budgets;
- quick completion without a duplicate follow-up;
- yielded completion with exactly one automatic delivery;
- sliding quiet and maximum-hold batching deadlines, including cancellation;
- quiet-window flushes independent of agent activity, fresh groups after a flush,
  and before-settle delivery of a result still inside its quiet window;
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
- pre-spawn blocking and next-run reset for state-only and duplicate commands,
  plus the plain-sleep guard while a background terminal runs;
- hard timeout status and tree termination;
- Bash-specific syntax on the resolved shell;
- pre-spawn cancellation preventing execution and fallback, including during initialization;
- post-spawn abort leaving eventual completion deliverable;
- redirected SIGTERM-resistant descendants reaped on natural exit and disposal;
- archive refs from an old runtime rejected after recreation;
- process-tree kill, pre-shell Windows job membership, reload-safe native FFI,
  SIGKILL escalation, and abnormal process-exit cleanup;
- session disposal, spill-directory cleanup, and per-entry pruning cleanup;
- output head stability, rolling tail, UTF-8 boundaries, and omission counts;
- complete spill capture beyond the memory cap;
- opaque archive references, bare-id and `id:stream` refs, `terminal_log_read`
  auto head+tail / page / tail / search modes with byte-exact offsets and
  limits, CRLF and chunk-boundary matching, abort-aware scanning,
  settled/complete metadata, UTF-8-exact paging of a multi-byte archive,
  per-run read budgets, and expired-entry errors;
- `terminal_wait` returning a consumed settlement once (no follow-up),
  first-of-two races, timeout still-running results whose later exit IS
  delivered, queued pending results, and the nothing-to-wait-for error;
- `terminal_stop` consuming its settlement (one-line result, no completion
  message), already-exited and unknown-id errors, and `/ps` kills delivered
  with `deliverAs: "nextTurn"`;
- `waitForAny`/`stop` waiter consumption semantics against the live registry;
- drain-once result delivery without direct TUI stderr writes on retry;
- `/ps` selection, default Info tab/invocation metadata, sanitization,
  wrapping, and cache behavior;
- spill-window follow/backfill/re-anchor anchoring, UTF-8 boundaries, and
  degradation when the log becomes unreadable.

The suite runs without `--test-force-exit`, so leaked handles cannot be hidden
by forcibly exiting the test runner. Unicode paging tests cover three- and
four-byte characters at non-aligned window boundaries, and `/ps` component
interaction tests verify that scrolling pauses both memory and disk output.

Validation commands:

```bash
pnpm --filter @tian.zuo/pi-background-terminals run check
pnpm --filter @tian.zuo/pi-background-terminals test
pnpm run typecheck
pnpm run check
pnpm test
```

The publish workflow runs both typechecks and the package test suite before its
publish loop. The prerelease Effect runtime is pinned exactly to the beta used
by those checks so a consumer install cannot float to an unverified beta.
