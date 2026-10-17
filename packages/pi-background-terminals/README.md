# @tian.zuo/pi-background-terminals

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-background-terminals/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

This extension replaces the built-in `bash` tool of Pi. Long commands move to
the background. The model can continue its work while these commands run.

```text
■ 2 background terminals running • /ps to view
```

## Overview

- Each command starts in a new shell. The tool waits a short time for the
  command to stop.
- If the command stops in that time, the tool returns the output.
- If the command continues after that time, the tool returns a terminal ID.
  The command continues in the background.
- When a background command stops, the extension sends the result to the model
  one time only.
- The `/ps` command shows all terminals and their full output.

The model has four tools:

| Tool | Function |
| --- | --- |
| `bash` | Runs a command. Moves a long command to the background. |
| `terminal_wait` | Waits until a background terminal stops. Returns the result. |
| `terminal_stop` | Stops a background terminal and all of its child processes. |
| `terminal_log_read` | Reads or searches the full log of a terminal. |

## The `bash` tool

Pi lets an extension replace a built-in tool that has the same name. This
extension registers `bash`. The model does not have to select between two
shell tools. At startup, Pi can show a warning about the replaced tool. This
warning is expected.

### Parameters

| Parameter | Description |
| --- | --- |
| `command` | The Bash script to run. This parameter is necessary. |
| `timeout` | The maximum run time in seconds. At this time, the extension stops the full process tree. There is no default limit. |
| `working_dir` | The directory for the command. The default is the session directory. A `cd` command alone has no effect on later calls. |
| `title` | A short label for `/ps`. The default label comes from the command, without a `D=/path;` or `cd /path &&` prefix. |
| `yield_time_ms` | The initial wait in milliseconds. The default is 10,000 ms. A value below 250 ms or above 300,000 ms changes to the nearest limit. |

### Sequence for each call

1. The extension finds Bash with the usual Pi procedure. It keeps the Pi
   settings `shellPath` and `shellCommandPrefix`.
2. The extension adds `<agent-dir>/bin` to `PATH` if it is not there. It sets
   `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and
   `PI_REASONING_LEVEL`, as the built-in tool does.
3. The extension starts the command in a new shell. The command has no
   interactive input. The extension records stdout and stderr separately.
4. If the command stops during the initial wait, the tool returns the exit
   status and the output. For a large output, the tool shows only the start
   and the end. A non-zero exit or a timeout is a tool error.
5. If the command continues after the initial wait, the tool returns a
   terminal ID, for example `bt-a12b34c56d78ef90-1`.

### Results of background commands

When a background command stops, the extension sends the result to the model.
The model receives the result after its next tool call. This lets the model
continue its work. If no agent run is active, the result starts a new run.

The extension sends each result one time only. If commands stop at almost the
same time, the extension sends one message for all of them:

- It waits until no new result comes for 1,000 ms.
- It does not wait more than 3,000 ms in total.
- One message contains a maximum of 32 KiB.

If the model ends its run while a result waits, the extension sends that
result immediately. The model then continues in the same run.

### Limits

- A maximum of 8 commands can run at the same time. This limit includes
  foreground commands and background terminals.
- If 8 commands run, a new call waits for a free slot. The calls start in the
  sequence that they arrive. If no slot becomes free in 10 seconds, the call
  fails.
- The extension keeps the data of the last 32 terminals.
- The maximum `timeout` is approximately 2,147,483 seconds. This is the limit
  of a Node.js timer.

### Cancellation

- If you cancel a call before the command starts, the command does not start.
  This rule also applies to a call that waits for a free slot, and to the
  fallback.
- If you push Esc after the command starts, only the initial wait stops. The
  command continues in the background. The result comes later, as usual.

### Fallback to the built-in tool

The extension uses the standard foreground `bash` tool of Pi in two
conditions:

- The managed runtime cannot start.
- A start error shows that no child process exists.

The result then contains a warning. The warning tells that the background
function and `/ps` are not available for this call.

The extension does not use the fallback after a command starts. It also does
not use the fallback after an exit error, a timeout, or a cancellation. A
second run of a command can cause its side effects two times.

## The `terminal_wait` tool

Use this tool when the model has no other work to do. Do not use `sleep` for
this purpose.

| Parameter | Description |
| --- | --- |
| `ids` | The terminal IDs. The default is all background terminals that run. |
| `timeout` | The maximum wait in seconds. The default is 300 s. A value below 1 s or above 3,600 s changes to the nearest limit. |

- The tool returns when one of the terminals stops.
- If a result waits for delivery, the tool returns that result immediately.
  The `running` field still names the other background terminals that run,
  because the default target is all of them.
- The tool returns the result in place of the later message. The extension
  does not send that result again.
- The timeout or Esc stops the wait. They do not stop a terminal. A terminal
  that stops at the same moment as the Esc still sends its result: the wait
  returns it, or the extension sends the usual message.
- If a terminal failed or had a timeout, the result is a tool error.

## The `terminal_stop` tool

| Parameter | Description |
| --- | --- |
| `id` | The terminal ID. |

- The tool stops the full process tree. On POSIX systems, it sends SIGTERM
  first and SIGKILL after 2 seconds. On Windows, it stops the tree
  immediately.
- The tool returns one line of status. The extension does not send a later
  message for this terminal.
- Use this tool to restart a server, or to stop work that is not necessary.

If the user stops a terminal in `/ps`, the model receives a message about it.
This message comes with the next user prompt. It does not start a new agent
run.

## The `terminal_log_read` tool

This tool reads the full log of a terminal. It does not control the process.

| Parameter | Description |
| --- | --- |
| `ref` | The terminal ID. The default stream is stdout. Add `:stderr` to read stderr. |
| `limit` | The maximum number of bytes to return. The default is 8 KiB. The maximum is 64 KiB. |
| `offset` | The start byte of an exact page. To read the next page, use the returned `next_offset`. |
| `tail` | Returns the last `limit` bytes. You cannot use `tail` with `offset` or `pattern`. |
| `pattern` | A regular expression. The search ignores case. The tool returns each line that matches, with its byte offset. |

- If you do not set `offset`, `tail`, or `pattern`, the tool returns the full
  log when the log is not larger than `limit`. Otherwise, the tool returns the
  start and the end of the log, and the byte range that it does not show.
- A search shows a maximum of 300 characters for each line. If the matches do
  not fit in `limit`, `next_offset` is the start of the first match that the
  tool does not show. To continue the search, use this value as `offset`.
- A search always shows the first match. If that line is larger than `limit`,
  the tool cuts the line. Thus each search continues past its first match.
- The search runs outside the main process. A pattern that would take very
  long on a repetitive log stops after 15 s with an error instead of slowing
  the session. Simplify the pattern, or narrow the range with `offset`.
- All pages start and end at UTF-8 character boundaries. The pages connect
  without errors. If `limit` is smaller than one character, the page contains
  that full character.
- For calls from the model, each agent run has a limit of 8 reads and 256 KiB.
  This limit does not apply to calls from a Code Mode script or to Bash
  commands.

Each terminal ID contains a random runtime ID. An ID from before `/reload` or
`/resume` cannot read the output of a different command. Such an ID is not
available.

## Use with Code Mode

In Code Mode, the model writes a JavaScript script that calls tools. The
script receives the tool results. The model receives only the output of the
script. The script has no timers.

- In a script, `bash` returns an object. It has the fields of the built-in
  tool: `output`, `truncated`, `exit_code`, and `wall_time_seconds`. It also
  has the fields `terminal_id` and `status`.
- In a script, a non-zero exit does not cause an exception in `bash`. Examine
  `exit_code` or `status` instead.
- `exit_code` is not present while the command runs. It is also not present
  after a signal or a timeout stops the command.
- `output` contains stdout and then stderr. It holds up to 1 MiB together,
  the same limit as the built-in tool. Longer output keeps its first and last
  512 KiB around a `[... N bytes omitted ...]` marker, and `truncated` is
  true. To read the full log, use `terminal_log_read` with `terminal_id`.
  A stream that is still running has no complete log file, so `output`
  holds the bounded in-memory view instead.
- The object does not contain `full_output_path`, because the log files are
  private.
- If a `bash` call in a script moves to the background, `status` is
  `running`. The result comes to the model only after the script ends. To use
  the result in the same script, call `tools.terminal_wait` with
  `terminal_id`.
- A script can start more than 8 commands, for example with `Promise.all`.
  The extension runs a maximum of 8 at the same time. The other calls wait.
- In a script, `terminal_wait` returns an object with the fields `settled`,
  `running`, `alreadyReported`, and `text`. Each item in `settled` contains the
  ID, the status, and the exit code of a terminal that stopped.
- In a script, a failed terminal does not cause an exception in
  `terminal_wait`. Examine `status` instead.
- In a script, `terminal_log_read` returns an object, for example with the
  fields `text`, `nextOffset`, `mode`, and `matches`.
- Reads from a script do not have the limit for each agent run. Their output
  goes to the script, not to the model.
- If the script ends before `terminal_wait` returns, the wait stops. The
  result then comes to the model as a usual message. No result is lost.
- If a script receives a result from `terminal_wait`, only the script has that
  result. Put the important part in the script output, for example with
  `text()`.

Example:

```js
const started = await tools.bash({ command: "pnpm test", yield_time_ms: 1000 });
if (started.status === "running") {
  const waited = await tools.terminal_wait({ ids: [started.terminal_id] });
  text(waited.text);
} else {
  text(`exit ${started.exit_code}\n${started.output}`);
}
```

## Safety rules for commands

The extension refuses some commands before they start. Each refusal tells the
correct procedure.

- **A command that only changes the shell state.** Examples are
  `cd packages/x` and `export FOO=1`. The shell stops after each call, so the
  change has no effect. The error tells you to use `working_dir`.
- **The same command again.** The extension refuses a command that is
  identical to an active command in the same directory. A second copy can
  cause all side effects two times.
- **A long `sleep`.** The extension refuses a `sleep N` command of 10 seconds
  or more while a background terminal runs. An `echo` after the sleep does not
  change this. A sleep does not make a result come sooner. The error tells you
  to use `terminal_wait`.

To wait for a server, poll the server in one command, for example
`until curl -fs <url>; do sleep 1; done`. The extension allows shorter sleeps.
It also allows a sleep when no background terminal runs.

If the syntax is not clear, the extension does not refuse the command.
Examples are a redirect and a command substitution. Each result also shows the
directory where the command ran.

## The `/ps` viewer

When one or more background terminals run, a status line shows above the
editor. The `/ps` command opens a full-screen view with two levels.

1. **List.** This level shows all terminals. The newest terminal is at the
   top.
   - `↑`/`↓` or `j`/`k`: Select a terminal.
   - `Enter`: Open the terminal.
   - `x`: Stop the selected terminal.
   - `Esc`: Close the view.
2. **Detail.** This level has three tabs: **Info**, **stdout**, and
   **stderr**.
   - **Info** shows the full data of the call: command, directory, PID,
     status, times, timeout, exit status, output sizes, log paths, and errors.
   - `t`, `←`/`→`, or `h`/`l`: Change the tab.
   - `↑`/`↓`, `PgUp`/`PgDn`, `g`/`G`: Scroll the output.
   - `x`: Stop the terminal.

The output tabs show new output when it comes. If you scroll up, the view
stays at that position. When a stream is larger than the memory limit, the
view reads the full log file from the disk. If you scroll above the loaded
part, the view loads earlier bytes. `G` goes back to the end of the output. A
note row shows the loaded size, the size before and after it, and the log
path.

## Design

### Output storage

- In memory, each stream keeps the first 256 KiB and the most recent output,
  to a maximum of 2 MiB. A marker shows the bytes that are not kept.
- The extension writes the full output of each stream to a log file on the
  disk. The file has the mode `0600`, in a directory with the mode `0700`.
  Each file has a maximum of 256 MiB.
- The extension deletes the log files of a terminal when it removes the
  terminal from the history of 32 entries.
- `/ps` reads the log file in a limited window. The window is 1 MiB at the
  end, and a maximum of 4 MiB when you scroll back.

### Output for the model

- A `bash` result shows a maximum of 16 KiB of stdout and 8 KiB of stderr.
- A completion message shows a maximum of 8 KiB of stdout and 4 KiB of stderr.
  After a failure or a timeout, it shows 16 KiB and 8 KiB.
- If the tool does not show all output, the result gives a log reference. The
  model can read the full log with `terminal_log_read`.

### Changes made while a command ran

- The extension records each successful `edit` and `write` call against
  the commands that run at that time. If a file inside the working directory
  of a command changed, the final result of that command tells it:
  `Changed while this command ran: src/lib.ts. The result may not reflect
  those changes; run the command again if they matter to it.`
- The note is in the completion message, in `terminal_wait`, and in the
  `bash` result of a command that stops during its initial wait. A tool call
  that runs in parallel can change a file during that wait. The note is also
  in `terminal_stop` if the terminal stopped before the call and its result
  was not sent. The note shows a maximum of 8 paths. It gives the number of
  the other paths.
- The note gives paths relative to the working directory of the command,
  with `/` separators on every platform.
- A change stays recorded until the terminal is removed from the history of
  32 entries. A new agent run does not remove it, because a command can start
  in one run and stop in a later run.
- The note does not cause an action. The extension does not run the command
  again, a successful result stays successful, and the extension does not
  find file dependencies. The extension does not detect changes that shell
  commands make, for example `sed -i`, `cargo fmt`, or `git apply`.

### Process trees

- On POSIX systems, each command has its own process group. The extension
  also stops child processes that redirect their output.
- On Windows, the extension creates a Job Object before each terminal starts.
  A small launcher adds itself to the job before Bash starts. All child
  processes are then in the job. When the extension closes the job handle,
  Windows stops all of them. The extension first tries `taskkill /T`.
- If the host does not allow nested jobs, the extension uses only `taskkill`.
- A shutdown or a hard timeout sends SIGTERM. After 2 seconds, it sends
  SIGKILL.
- If Pi crashes, a process-exit handler stops all managed process trees.

### Session scope

The commands `/new`, `/resume`, `/fork`, `/reload`, and quit stop all process
trees. They also remove the log directory of the session.

### Internal structure

The async core uses [Effect](https://effect.website) v4. The Node.js
`child_process` output uses callbacks. For the internal rules, refer to
[`docs/implementation-guide.md`](./docs/implementation-guide.md).

## Install

1. Install the package:

   ```bash
   pi install npm:@tian.zuo/pi-background-terminals
   ```

2. Restart Pi, or type `/reload`.

## Development

This workspace uses Effect `4.0.0-rc.117` and TypeScript 7 (`tsgo`). Do the
checks for this package only:

```bash
pnpm install --filter @tian.zuo/pi-background-terminals
cd packages/pi-background-terminals
pnpm run check
pnpm test
```

The tests do not force the process to exit. They include tests for child
processes that redirect their output, cancellation before start, and terminal
IDs for each runtime.

## License

MIT
