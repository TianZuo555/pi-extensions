---
"@tian.zuo/pi-devin-acp": patch
---

Keep finished devin operations from resurrecting in /devin-tasks. Devin
re-emits a non-terminal `tool_call_update` under the original toolCallId
when a later `get_output` read (or late PTY output) touches a completed
exec session, which brought the op back as "running" forever. Tool-call
ids that reach a terminal status or `terminal_exit` are now tombstoned so
late re-notifications can no longer re-open them; genuinely running ops
still track normally, and `d` dismissal behavior is unchanged.
