---
"@tian.zuo/pi-background-terminals": patch
---

Harden background terminal lifecycle and model-facing results across the board.

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
