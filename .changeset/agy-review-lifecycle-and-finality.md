---
"@tian.zuo/pi-antigravity": patch
---

Protect live foreground commands from `/agy-tasks stop all` by verifying the recorded agy parent's identity and requiring it to have exited; the sweep also runs with no live conversation, so a `/agy reset` no longer leaves recorded orphans unreachable until shutdown. Keep whole-Pi shutdown able to reap attached work, and escalate the actual signalled process groups rather than treating log-holder PIDs as PGIDs.

Poll transcript completion during tool-liveness grace periods without consuming additional grace budgets, and skip parked waits that would cross the turn deadline. Expand transcript tails with an 8 MiB cap so large JSONL final answers remain recoverable.

Track response-step text across tool handoffs so a final-only result completes a partially streamed answer instead of repeating its prefix.
