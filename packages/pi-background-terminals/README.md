# pi-tian-background-terminals

A managed replacement for Pi's built-in `bash` tool.

Every model shell command follows one path: start it, wait briefly, and return
its final output if it finishes. If it outlives the initial wait, return control
to the model while the command continues as a session-scoped background
terminal. Its final result is delivered automatically exactly once.

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
- `working_dir` — optional working directory; defaults to the current directory.
- `title` — optional short `/ps` label; defaults to a bounded one-line command.
- `yield-time_ms` — optional initial wait, default **10 seconds**. Integer values
  are clamped to **250–30,000 ms** rather than rejected when out of range.

Behavior:

1. Resolve Bash using Pi's normal platform logic and preserve Pi's configured
   `shellPath` and `shellCommandPrefix` settings.
2. Preserve Pi's managed `PATH` (`<agent-dir>/bin` is prepended unless already
   present) and inject the same `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`,
   `PI_MODEL`, and `PI_REASONING_LEVEL` values as built-in Bash.
3. Start the command with no interactive stdin and stream bounded progress in
   the normal Bash tool row.
4. If it exits during `yield_time_ms`, return its final status and bounded
   head+tail output. Non-zero exits and hard timeouts are Bash tool errors.
5. If it remains alive, return an id such as `bt-1`. The model should continue
   working rather than poll. A follow-up message wakes it exactly once when the
   process exits.

There are no model-facing status, list, kill, polling, or stdin tools. The user
owns inspection and termination through `/ps`.

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
2. **Detail** — metadata, `t`-toggled stdout/stderr, live tailing, scrolling
   (`↑/↓`, `PgUp/PgDn`, `g`/`G`), and `x` to stop. Once a stream outgrows its
   in-memory retention the viewer reads the **complete on-disk log** instead:
   scrolling past the top of the loaded window pulls in earlier bytes, `G`
   returns to the live tail. The note row shows how much is loaded, how much
   lies on either side, and the log's path.

## Design

- **Automatic yielding, no polling.** Quick commands return directly; only
  commands that outlive the initial wait become background work. Completion
  uses `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`.
- **Exactly-once completion.** A race-safe waiter token decides whether the
  initial Bash call or the later follow-up owns settlement. A drain-once map
  handles delivery retries without duplicates.
- **Bounded head+tail memory plus full capture.** Each stdout/stderr stream
  retains a stable **256 KiB startup head** and rolling tail within a **2 MiB**
  cap. Omitted middle bytes are marked. Complete output spills from byte zero
  to an owner-only file (`0600` in a `0700` session directory), capped at
  256 MiB per stream. A terminal's spill files are deleted when it is pruned
  from the 32-entry history. The `/ps` detail view pages that file through a
  bounded window (1 MiB live tail, up to 4 MiB when reading backwards), so the
  user can read output the model's bounded result never showed.
- **Separate stdout and stderr.** Both streams are independently retained,
  spilled, inspected, and formatted.
- **No interactive stdin.** Normal commands see EOF. The legacy WSL Bash
  transport may receive the script over stdin, but that pipe is closed
  immediately and cannot be used interactively.
- **Process-tree termination.** POSIX children use their own process group;
  Windows uses `taskkill /T`. Shutdown and hard timeouts send SIGTERM and
  escalate to SIGKILL after two seconds. A synchronous process-exit tracker
  also kills managed trees when a Pi crash bypasses normal extension cleanup.
- **Session scoped.** `/new`, `/resume`, `/fork`, `/reload`, and quit terminate
  every process tree and remove the remaining spill directory.

The async core uses [Effect](https://effect.website) v4. Node
`child_process` output remains callback-driven. See
[`docs/implementation-guide.md`](./docs/implementation-guide.md) for internal
invariants.

## Install

```bash
pi install npm:pi-tian-background-terminals
```

Restart Pi or run `/reload` afterwards.

## Development

This workspace pins Effect `4.0.0-beta.101` and uses TypeScript 7 (`tsgo`), so
it is checked in isolation:

```bash
npm install -w pi-tian-background-terminals
cd packages/pi-background-terminals
npm run check
npm test
```

## Credits

Ported from [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup/tree/main/extensions/background-terminals).

## License

MIT
