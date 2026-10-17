---
"@tian.zuo/pi-background-terminals": minor
---

Add `terminal_wait` and `terminal_stop`, make `terminal_log_read` cheaper to use, raise the initial-wait cap, and support Code Mode scripts.

- `terminal_wait` blocks until a background terminal exits and returns its result in place of the later completion message, replacing sleep-and-poll turns. In Code Mode scripts it resolves to structured fields (`settled`, `running`, `alreadyReported`, `text`). A plain `sleep` of 10 s or more is refused while a background terminal runs and points at it.
- `terminal_stop` stops a terminal's process tree with a one-line result and no completion message, so the model can restart servers it started. A stop from `/ps` is delivered with the next user turn instead of waking an idle model.
- `terminal_log_read` accepts a bare terminal id, defaults to an 8 KiB head+tail view, and adds `tail` (newest bytes) and `pattern` (case-insensitive search over the whole log with byte offsets). Reads from Code Mode scripts are exempt from the per-run read budget, because their output reaches the script, not the model context.
- A `bash` call from a Code Mode script that yields says its result arrives after the script ends and how to collect it with `terminal_wait`.
- `bash` returns structured results (`output`, `truncated`, `exit_code`, `wall_time_seconds`, `terminal_id`, `status`) on every managed result, so a non-zero exit resolves to fields in Code Mode scripts instead of throwing.
- `bash` calls beyond 8 concurrent commands queue for up to 10 s for a free slot instead of failing immediately.
- `terminal_log_read` paging and tail no longer emit replacement characters when `limit` is smaller than one code point, and a capped search always advances `next_offset` so continuation cannot loop.
- `yield_time_ms` is clamped to 250–300,000 ms instead of 30,000 ms.
- Bash guidance tells the model to use a short initial wait for tests, builds, or similar tasks when independent work remains. It points at `terminal_wait` when the result is needed or no other work remains, instead of sleep or repeated log reads. CI and deploy waits still use one blocking command.
