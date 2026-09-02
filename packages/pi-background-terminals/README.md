# @tian.zuo/pi-background-terminals

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-background-terminals/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

A managed replacement for Pi's built-in `bash` tool.

Every model shell command follows one path: start it, wait briefly, and return
its final output if it finishes. If it outlives the initial wait, return control
to the model while the command continues as a session-scoped background
terminal. Its final result is delivered automatically exactly once. Results
that settle close together share one bounded follow-up; an isolated result keeps
its existing message shape. Quick Bash calls show a bounded command/output
preview in the main transcript; only calls that actually yield collapse to
compact terminal rows. `/ps` retains complete invocation metadata and the
detailed stdout/stderr viewer.

```text
■ 2 background terminals running • /ps to view
```

## Canonical `bash` override

Pi officially supports replacing a built-in tool by registering the same name.
This extension registers `bash`, so the model no longer chooses between normal
Bash and a separate background tool. Pi may display an expected startup warning
that the built-in has been overridden.

Parameters:

- `command` — Bash script to execute.
- `timeout` — optional hard total runtime timeout in seconds. When reached, the
  whole process tree is terminated. There is no default runtime timeout.
- `working_dir` — optional working directory for this fresh shell invocation;
  defaults to the session directory. A standalone `cd` never affects later calls.
- `title` — optional short `/ps` label. The default strips common leading
  `D=/path;` or `cd /path &&` setup and preserves both ends when bounding a long
  command, so repeated setup prefixes do not hide the actual work.
- `yield-time_ms` — optional initial wait, default **10 seconds**. Integer values
  are clamped to **250–30,000 ms** rather than rejected when out of range.

Behavior:

1. Resolve Bash using Pi's normal platform logic and preserve Pi's configured
   `shellPath` and `shellCommandPrefix` settings.
2. Preserve Pi's managed `PATH` (`<agent-dir>/bin` is prepended unless already
   present) and inject the same `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`,
   `PI_MODEL`, and `PI_REASONING_LEVEL` values as built-in Bash.
3. Start the command in a fresh shell with no interactive stdin and capture
   stdout/stderr. During the initial wait, the main Bash row shows the useful
   command title and a small sanitized output preview.
4. If it exits during `yield_time_ms`, return its final status and bounded
   head+tail output to the model. Non-zero exits and hard timeouts are Bash tool
   errors. The TUI keeps the quick command visibly distinct from background work.
5. If it remains alive, return an id such as `bt-1`. Only then does the row
   collapse to compact background-terminal status. The model should continue
   rather than poll. Nearby exits share one compact follow-up after a 1,000 ms
   sliding quiet window, with a 3,000 ms maximum hold. An isolated exit keeps
   the original message shape, and every terminal result remains exactly-once.
   Detailed stdout/stderr remain in `/ps`.

There are no model-facing status, list, kill, polling, or stdin tools. The
read-only `terminal_log_read` tool only pages an opaque archive ref emitted by
`bash`; it returns at most 64 KiB per call, and 256 KiB across at most 8 reads
per agent run. The user still owns terminal inspection and termination through
`/ps`.

To prevent an agent from spending an entire run on recursive shell searches,
the extension counts recognized read-only Bash inspection commands across the
whole agent run. It starts adding a model-facing synthesis warning at call 6 and
blocks call 9 (limit 8) before spawn. The counter resets for the next agent run;
normal builds, tests, and other unrecognized execution commands are not counted.

### Safe foreground fallback

If the managed Effect runtime cannot initialize—or `start()` returns a typed
spawn error proving no child was created—the extension falls back to Pi's
standard foreground Bash implementation. The result includes a warning that
automatic yielding and `/ps` tracking were unavailable.

The extension deliberately never retries through fallback after a spawn,
non-zero exit, timeout, or abort. Re-executing an arbitrary shell command could
duplicate destructive side effects.

## `/ps` viewer

While at least one terminal runs, a one-line widget renders above the editor.
`/ps` opens a two-stage full-screen overlay:

1. **List** — every tracked terminal, newest first; `↑/↓`/`j`/`k` select,
   `Enter` inspect, `x` stop the selected running terminal, `Esc` close.
2. **Detail** — three tabs ordered **Info** (default), **stdout**, **stderr**.
   Info shows the complete invocation metadata (command, cwd, PID, status,
   timing/timeout, exit state, stream sizes, spill paths, and errors). `t`,
   `←/→`, or `h`/`l` switches tabs. Output tabs support live tailing, scrolling
   (`↑/↓`, `PgUp/PgDn`, `g`/`G`), and `x` to stop. Once a stream outgrows its
   in-memory retention the viewer reads the **complete on-disk log** instead:
   scrolling past the top of the loaded window pulls in earlier bytes, `G`
   returns to the live tail. The note row shows how much is loaded, how much
   lies on either side, and the log's path.

## Design

- **Automatic yielding, no polling.** Quick commands return directly; only
  commands that outlive the initial wait become background work. Completion
  uses `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`.
- **Truthful quick-vs-yielded rendering.** Quick and initial-wait Bash rows show
  a bounded sanitized preview. Only a command that actually yields is rendered
  as a compact background terminal; asynchronous completion rows remain compact.
- **Fresh-shell guidance.** Model guidance points to `working_dir` instead of
  persistent `cd` assumptions and prefers dedicated inspection tools.
- **Loud failure for the two silent mistakes.** Prompt wording only makes a
  misunderstanding less likely, so both contract errors that produce *no* error
  signal are refused before spawning. A command that only mutates the discarded
  shell (`cd packages/x`, `export FOO=1`) is rejected with the `working_dir`
  fix, because otherwise it exits 0 and the next call silently runs elsewhere.
  Re-issuing a command identical to one still running in the same directory is
  rejected too, because a yielded command looks like a hang and the duplicate
  would repeat every side effect while both copies report success. Ambiguous
  syntax (redirects, command substitution) always fails open. Every settled
  result also names the directory the command actually ran in, because the
  common mistake is assuming a cwd that was never set.
- **Exactly-once batched completion.** A race-safe waiter token decides whether
  the initial Bash call or a later follow-up owns settlement. A drain-once map
  handles delivery retries without duplicates. A bounded quiet-window scheduler
  combines nearby map entries into one follow-up, caps aggregate content at
  32 KiB, and leaves isolated completion messages unchanged.
- **Bounded head+tail memory plus full capture.** Each stdout/stderr stream
  retains a stable **256 KiB startup head** and rolling tail within a **2 MiB**
  cap. Omitted middle bytes are marked. Complete output spills from byte zero
  to an owner-only file (`0600` in a `0700` session directory), capped at
  256 MiB per stream. A terminal's spill files are deleted when it is pruned
  from the 32-entry history. The `/ps` detail view pages that file through a
  bounded window (1 MiB live tail, up to 4 MiB when reading backwards), so the
  user can read output the model's bounded result never showed.
- **Separate stdout and stderr.** Both streams are independently retained,
  spilled, inspected, and formatted. The model can page a bounded settled
  archive with `terminal_log_read` using the opaque ref and byte offsets from
  the Bash result; windows are snapped to UTF-8 boundaries so paging with
  `next_offset` is byte-exact, and the tool never reports status or controls a
  process.
- **No interactive stdin.** Normal commands see EOF. The legacy WSL Bash
  transport may receive the script over stdin, but that pipe is closed
  immediately and cannot be used interactively.
- **Process-tree termination.** POSIX children use their own process group.
  On Windows the manager creates a dedicated Job Object before starting a
  terminal, and a pre-shell launcher joins it before Bash can run; every
  descendant therefore inherits `KILL_ON_JOB_CLOSE` membership without an
  assignment race. Closing the handle reliably reaps descendants that outlive
  the shell and keep stdio pipes open, with `taskkill /T` as the first attempt.
  Hosts whose outer Windows job forbids nesting are detected once and retain
  the legacy direct-spawn/taskkill fallback. Shutdown and hard timeouts send
  SIGTERM and escalate to SIGKILL after two
  seconds. A synchronous process-exit tracker also kills managed trees when a
  Pi crash bypasses normal extension cleanup.
- **Session scoped.** `/new`, `/resume`, `/fork`, `/reload`, and quit terminate
  every process tree and remove the remaining spill directory.

The async core uses [Effect](https://effect.website) v4. Node
`child_process` output remains callback-driven. See
[`docs/implementation-guide.md`](./docs/implementation-guide.md) for internal
invariants.

## Install

```bash
pi install npm:@tian.zuo/pi-background-terminals
```

Restart Pi or run `/reload` afterwards.

## Development

This workspace pins Effect `4.0.0-beta.101` and uses TypeScript 7 (`tsgo`), so
it is checked in isolation:

```bash
pnpm install --filter @tian.zuo/pi-background-terminals
cd packages/pi-background-terminals
pnpm run check
pnpm test
```

## Credits

## License

MIT
