---
"@tian.zuo/pi-background-terminals": minor
---

Add `terminal_wait` and `terminal_stop`, make `terminal_log_read` cheaper to use, and raise the initial-wait cap.

- `terminal_wait` blocks until a background terminal exits and returns its result in place of the later completion message, replacing sleep-and-poll turns. A plain `sleep` is refused while a background terminal runs and points at it.
- `terminal_stop` stops a terminal's process tree with a one-line result and no completion message, so the model can restart servers it started. A stop from `/ps` is delivered with the next user turn instead of waking an idle model.
- `terminal_log_read` accepts a bare terminal id, defaults to an 8 KiB head+tail view, and adds `tail` (newest bytes) and `pattern` (case-insensitive search over the whole log with byte offsets).
- `yield_time_ms` is clamped to 250–300,000 ms instead of 30,000 ms.
- Bash guidance points at `terminal_wait` and at one blocking command for CI and deploy waits.
