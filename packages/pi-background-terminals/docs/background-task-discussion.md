# Background terminal discussion

Date: 2026-10-17

Related pull request: [#161](https://github.com/TianZuo555/pi-extensions/pull/161)

## Purpose

The agent must be able to do other work while a long command runs.
Unit tests and builds are common examples. The agent must also receive the
result when the command stops.

This record separates the current decisions from changes that we discussed
but did not approve for this update.

## Current decisions

### Keep the 10-second initial wait

Keep the default `yield_time_ms` at 10,000 ms.
This value controls how long the first Bash call waits. It does not limit
how long the command can run. The `timeout` parameter sets that limit.

We considered a 60-second default. We did not select it because it would
keep the agent waiting longer before it could do other work.
For known parallel work, the agent can set a shorter initial wait.
An Esc action can end the initial wait after the command starts. The
command then continues in the background.

### Keep automatic result messages

When a background command stops, send its result once. The message can
start an agent run if no run is active. Combine results that arrive close
together into one message.

If `terminal_wait` receives the result, do not send the result again.
Keep the existing behavior for commands stopped through `/ps`: report the
stop with the next user turn instead of starting an agent run.

### Keep the log tool

Keep `terminal_log_read`, its log references, and its read limits.
Do not replace the references with file paths in this update.

Review recent use after these changes have been used. Check how often the
agent reads logs to see progress and how often it reads output that was
omitted from a result. Use that evidence before a decision to remove the
tool.

### Add a note about observed file changes

Include the existing local change that records successful `edit` and
`write` calls while commands run.
For each running command, record changed files inside its working
directory. Put the note before the output in its final result.
For example:

```text
Changed while this command ran: src/lib.ts, tests.rs. The result may not
reflect those changes; run the command again if they matter to it.
```

Show a maximum of eight paths. Show the number of additional paths.
Keep the record across agent runs while the command remains in history.

The note gives information. It does not start another command or change
a successful status to a failure. It does not establish which files a
command uses. It does not detect changes made by Bash or external tools.
A change during execution does not prove that a test result is obsolete:
a command can read a file before or after the change.

This feature needs runtime tracking. It is not only a change to the tool
description.

### Keep non-interactive execution

Do not add interactive input or a pseudo-terminal. Commands must use
non-interactive flags when necessary.

## Codex comparison

We compared the design with the Codex unified execution interface.
An initial execution call can return a session ID before the command
stops. A later `write_stdin` call with empty input waits and collects new
output. Repeated calls can cause repeated model turns.

The useful idea is to combine waiting and progress output in one call.
Keep our automatic completion messages. Client output events do not, by
themselves, establish that a model receives a completion message.
Timing limits can differ between Codex versions and settings.

## Changes not included in this update

- New output in `terminal_wait` when a wait times out. The current tool
  reports running status; `terminal_log_read` supplies progress output.
- A five-second minimum wait. The current minimum remains one second.
- A new rule that refuses a long `sleep` before another command. The
  current rule covers a plain long sleep, with an optional following echo.
- Separate retention rules for task history and full logs. The current
  limit remains 32 entries. Removal of an entry also removes its logs.
  Running entries are not removed to make space in history.
- A new general prompt about parallel test work. Discuss its exact text
  after this commit.

## Items for the next discussion

Consider a short instruction that tells the agent to continue independent
work after a test goes to the background. It must also tell the agent to
check whether later edits affect the final verification.

Review the new file-change tests for Windows path separators. The tracker
uses the platform path separator, but some assertions expect `/`.

If log paths are exposed in a later change, define their lifetime first.
A history limit and a log storage limit serve different purposes.
Do not delete a result or its required output before delivery.

When we review recent use, check repeated progress reads, sleep calls,
repeated test runs, and successful results followed by related edits.
Do not treat the usage estimates from this discussion as new measurements.

## Follow-up: parallel work prompt

The parallel work instruction was approved after the first commit of this
record. The Bash tool description now includes this text:

```text
For tests, builds, or similar tasks, use a short yield_time_ms if independent work remains.
Continue that work while the command runs.
Use terminal_wait when you need the result or have no other work.
Do not use sleep or repeated log reads to wait for completion.
```

This change adds guidance. It does not change the default wait or the
behavior of the log tool. The Windows path assertions remain a separate
item for discussion.

## Follow-up: session review of the yield and wait guidance

A review of the Pi sessions from 2026-10-15 to 2026-10-31 found two problems.

The first problem was in the instruction about a short `yield_time_ms`. In 149
of 482 background terminals, the initial wait was 2 s or less. 70 of these
commands stopped in 10 s or less, so the default wait would have returned
their output. In 33 of them, the next call was `terminal_wait`, with no other
work before it. The Bash tool description now includes this text:

```text
Keep the default yield_time_ms for tests and builds; an early yield only adds a terminal_wait call.
Continue independent work while it runs.
```

The `yield_time_ms` parameter tells the agent to lower the value only for
servers and watchers.

The second problem was the result delivery during a run. The extension sent
each result as a steer when the quiet window ended. Pi adds a steer to the
context only after the current tool batch. Thus a `terminal_wait` in that
batch found an empty queue and reported "delivered earlier" before the model
saw the result. This occurred in 63 of 66 such reports. During a run, the
extension now keeps the results until `turn_end`. A `terminal_wait` in the
batch returns them. Otherwise, one message at the turn boundary contains them.

## Follow-up: `bash` in Code Mode runs in the foreground

The same review found that 178 of 688 Code Mode scripts with `bash` ended
while a command still ran. These scripts did not get the output. Only 13 of
them checked the status or called `terminal_wait`. A script has no other work
during the wait, and a background result goes to the model, not to the
script. Thus a `bash` call from a script now waits until the command stops,
and it does not use `yield_time_ms`. If Esc or the script timeout stops the
wait, the command continues in the background as before.
