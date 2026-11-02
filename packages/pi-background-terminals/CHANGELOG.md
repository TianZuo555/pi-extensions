# @tian.zuo/pi-background-terminals

## 0.7.0

### Minor Changes

- [#187](https://github.com/TianZuo555/pi-extensions/pull/187) [`e6b7301`](https://github.com/TianZuo555/pi-extensions/commit/e6b73016520d5c74dd8a923e0e0145ea597c3724) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Remove `terminal_log_read`. A truncated result now gives the path of the full log file, and the model reads it with `read` or `grep`. A yielded result gives the log paths, so the model can check a server. In Code Mode, a truncated `output` adds `full_output_path` for stdout and `full_stderr_path` for stderr.
  
  The log files now stay until the session ends, with a total limit of 256 MiB for stopped commands. Past the limit, the oldest files are deleted first.
  
  Session data showed that the model read a truncated log in only 19 of 275 cases, ran the command again in 40 cases, and that 15 of 50 `terminal_log_read` calls failed.

### Patch Changes

- [#184](https://github.com/TianZuo555/pi-extensions/pull/184) [`2e579d4`](https://github.com/TianZuo555/pi-extensions/commit/2e579d48c1d7b73188ab078162e789296aa418eb) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix a race between `terminal_wait` and the result message. During an agent run, the extension now keeps each background result until the turn ends. Thus a `terminal_wait` in the same tool batch returns the result. It no longer reports "delivered earlier" before the model sees the result.
  
  Change the `bash` guidance: keep the default `yield_time_ms` for tests and builds. Lower it only for servers and watchers. Session data showed that a 1 s initial wait moved quick commands to the background, and the model then called `terminal_wait` at once.
  
  A `bash` call from a Code Mode script now waits until the command stops, and it does not use `yield_time_ms`. Before this change, 178 of 688 scripts with `bash` ended while a command still ran, so the script did not get the output.

- [#173](https://github.com/TianZuo555/pi-extensions/pull/173) [`5067811`](https://github.com/TianZuo555/pi-extensions/commit/506781181fdc1a9d5009278391312cdf8d47f6ae) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Move the runtime dependency to `effect@4.0.5` (from the `4.0.0-rc.117` release candidate), so installing this extension no longer pulls a pre-release Effect. `pi-usage` also picks up `playwriter@0.9.0` and `pi-web-search` `unpdf@1.9.1`. No API changes on the extension surface.

## 0.6.0

### Minor Changes

- [#161](https://github.com/TianZuo555/pi-extensions/pull/161) [`131a98a`](https://github.com/TianZuo555/pi-extensions/commit/131a98ac5a8331246dfc389c2c53b4bd3057a26d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Add `terminal_wait` and `terminal_stop`, make `terminal_log_read` cheaper to use, raise the initial-wait cap, and support Code Mode scripts.
  
  - `terminal_wait` blocks until a background terminal exits and returns its result in place of the later completion message, replacing sleep-and-poll turns. In Code Mode scripts it resolves to structured fields (`settled`, `running`, `alreadyReported`, `text`). A plain `sleep` of 10 s or more is refused while a background terminal runs and points at it. A wait or stop interrupted by Esc at the moment its terminal settles still delivers that result, so the interruption cannot lose it.
  - `terminal_log_read` runs its pattern search off-thread under a 15 s timeout, so a backtracking-heavy pattern can no longer slow the whole session; it fails with an error instead. `truncated` on a `bash` structured result now comes from the read metadata, so output that merely contains the phrase "bytes omitted" no longer reads as incomplete.
  - `terminal_stop` stops a terminal's process tree with a one-line result and no completion message, so the model can restart servers it started. A stop from `/ps` is delivered with the next user turn instead of waking an idle model.
  - `terminal_log_read` accepts a bare terminal id, defaults to an 8 KiB head+tail view, and adds `tail` (newest bytes) and `pattern` (case-insensitive search over the whole log with byte offsets). Reads from Code Mode scripts are exempt from the per-run read budget, because their output reaches the script, not the model context.
  - A `bash` call from a Code Mode script that yields says its result arrives after the script ends and how to collect it with `terminal_wait`.
  - `bash` returns structured results (`output`, `truncated`, `exit_code`, `wall_time_seconds`, `terminal_id`, `status`) on every managed result, so a non-zero exit resolves to fields in Code Mode scripts instead of throwing. `output` holds up to 1 MiB in total across stdout and stderr, as Pi's built-in tool does; longer output keeps its first and last 512 KiB around a `[... N bytes omitted ...]` marker with `truncated` set, and `terminal_log_read` reads the rest.
  - `bash` calls beyond 8 concurrent commands queue for up to 10 s for a free slot instead of failing immediately.
  - `terminal_log_read` paging and tail no longer emit replacement characters when `limit` is smaller than one code point, and a capped search always advances `next_offset` so continuation cannot loop.
  - `yield_time_ms` is clamped to 250–300,000 ms instead of 30,000 ms.
  - Bash guidance tells the model to use a short initial wait for tests, builds, or similar tasks when independent work remains. It points at `terminal_wait` when the result is needed or no other work remains, instead of sleep or repeated log reads. CI and deploy waits still use one blocking command.

- [#161](https://github.com/TianZuo555/pi-extensions/pull/161) [`131a98a`](https://github.com/TianZuo555/pi-extensions/commit/131a98ac5a8331246dfc389c2c53b4bd3057a26d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Report files the model changed while a command was running.
  
  A test that finishes after the code under test changed can report a pass for code that no longer exists, and nothing in the transcript says so. Successful `edit` / `write` calls are now recorded against every command running at that moment, and the final result — the completion message, `terminal_wait`, `terminal_stop`, or the `bash` result itself — states the fact:
  
  ```
  Background terminal bt-… "pnpm test" exited (exit 0) after 2m10s.
  Changed while this command ran: src/lib.ts, tests.rs. The result may not reflect those changes; run the command again if they matter to it.
  ```
  
  Only paths inside the command's working directory are named. A change stays recorded across agent runs until the terminal leaves the 32-entry history, because a command can start in one run and settle in a later one. It is a note, not an action: nothing is re-run, no successful result becomes a failure, and no file dependencies are inferred. Changes made by shell commands (`sed -i`, `cargo fmt`, `git apply`) are not detected.

## 0.5.4

### Patch Changes

- [#134](https://github.com/TianZuo555/pi-extensions/pull/134) [`e783584`](https://github.com/TianZuo555/pi-extensions/commit/e783584281c2208c3dfb7ce8637aa741b1f6d7d8) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Harden background terminal lifecycle and model-facing results across the board.
  
  - Return structured `{ id, status, yielded }` details plus `isError` on bash results instead of parsing model-facing text, fixing renderer misclassification (Esc-interrupted waits shown as failed, cwd names containing "killed" shown as killed).
  - Count only truly yielded terminals in the widget so quick foreground commands no longer flash "1 background terminal running".
  - Document that `cmd &` dies with its shell and that long-running servers should be a single call that auto-yields.
  - Allocate per-terminal budgets when assembling batched completion messages so stderr and `terminal_log_read` archive references survive truncation; point truncation guidance at `terminal_log_read` instead of `/ps`.
  - Prune settled non-yielded quick commands before yielded terminals, and compact settled buffers once the archive flush completes.
  - Move spill storage to a private per-session directory under the Pi agent dir and sweep stale session directories left by crashed processes.
  - Bind tool calls to the runtime that created the manager so a shutdown race cannot recreate a disposed runtime.
  - Clamp `terminal_log_read` to the remaining per-run byte budget and render the actual error instead of a blanket "archive unavailable"; honor Ctrl+O expansion in call/result rendering; correct the `/ps` empty-state wording.
  - Remove production-unused manager APIs, inject lifecycle timings for fast tests, move tests into `test/`, and refresh stale README/tsconfig/docs.
  - Deliver completion messages with `deliverAs: "steer"` instead of `followUp`, so a model that keeps working receives a yielded command's result after its next tool call rather than only after writing a final answer. The quiet-window batcher no longer holds results while the agent is busy, and a result still inside its window when a run is about to settle is delivered immediately so the same run continues (previously print/json mode could exit without it).
  - Return the final result when an Esc lands in the same instant the command settles, instead of claiming the command continues in the background with no completion ever coming.

- [#133](https://github.com/TianZuo555/pi-extensions/pull/133) [`ae1cf78`](https://github.com/TianZuo555/pi-extensions/commit/ae1cf7848c0afe57355ed1641dc346c473d6ecbf) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Return structured results from grep/find, web_search/web_fetch, and terminal_log_read so code-mode scripts can filter matches, search hits, and log pages without parsing tool text. Keep the tools on the model's list; the model still sees the existing compact content.

## 0.5.3

### Patch Changes

- [#39](https://github.com/TianZuo555/pi-extensions/pull/39) [`ac8e5ca`](https://github.com/TianZuo555/pi-extensions/commit/ac8e5ca9f6b661125e609aba458cea201d5aef93) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Reap redirected POSIX descendants on natural exit and shutdown, prevent pre-spawn cancellation from executing commands, and scope terminal/archive IDs to a unique runtime so stale references cannot read unrelated logs.
  
  Fix UTF-8 spill paging and window bounds, and pause live following immediately when scrolling through either retained or archived output. Keep disk paging available when pausing before the initial window loads or when retention overflows during a pause. Classify aborted spawns as unsafe for fallback. Centralize model-facing errors, correct documentation, and add regression coverage with forced test exit disabled.

## 0.5.2

### Patch Changes

- [#18](https://github.com/TianZuo555/pi-extensions/pull/18) [`da8a245`](https://github.com/TianZuo555/pi-extensions/commit/da8a24508455894eacee56df69f71c9ce67e93bd) Thanks [@Alx8g](https://github.com/Alx8g)! - Batch background terminals that finish close together into one bounded completion follow-up while preserving exactly-once delivery and the existing singleton message shape.

- [#20](https://github.com/TianZuo555/pi-extensions/pull/20) [`a45525c`](https://github.com/TianZuo555/pi-extensions/commit/a45525c4f64c0fec5e054366c4d0ffa4f37df2cd) Thanks [@Alx8g](https://github.com/Alx8g)! - Preserve the full quiet window for arrivals that follow a busy-held expiry, keep the maximum hold fixed, and charge truncation markers to the strict aggregate completion budget.

## 0.5.1

### Patch Changes

- [#7](https://github.com/TianZuo555/pi-extensions/pull/7) [`c160eaa`](https://github.com/TianZuo555/pi-extensions/commit/c160eaac7ba17055d8324f3e609e036d189bf66a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Force exit after the background-terminal test suite finishes and run test files serially. On Windows the test runner could linger for many minutes after all tests passed when a spawned shell handle outlived its test, and the serial run avoids the open Node test-runner race (nodejs/node#64833) where `--test-force-exit` with concurrency can drop verdicts.

- [#10](https://github.com/TianZuo555/pi-extensions/pull/10) [`21e8e95`](https://github.com/TianZuo555/pi-extensions/commit/21e8e95d62fdc8b9befb00df841658888d02b066) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Create a dedicated Windows Job Object before starting each background terminal, then use a pre-shell launcher to join the job before the requested Bash process can run. Closing the manager-owned `KILL_ON_JOB_CLOSE` handle now reaps the complete tree—including descendants re-parented after the shell exits—without a post-spawn assignment race. A startup probe preserves direct-spawn/taskkill fallback on hosts whose outer Job Object forbids nesting.

- [#4](https://github.com/TianZuo555/pi-extensions/pull/4) [`5a678c5`](https://github.com/TianZuo555/pi-extensions/commit/5a678c5d43a47f7cfbf18eec104e9f8daf40001b) Thanks [@nzalexgarciagil-ctrl](https://github.com/nzalexgarciagil-ctrl)! - Force-kill Windows process trees atomically so timeouts cannot leave detached descendants running.

## 0.5.0

- Changelog tracking was introduced after this release.
