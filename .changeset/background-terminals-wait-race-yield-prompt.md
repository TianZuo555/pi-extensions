---
"@tian.zuo/pi-background-terminals": patch
---

Fix a race between `terminal_wait` and the result message. During an agent run, the extension now keeps each background result until the turn ends. Thus a `terminal_wait` in the same tool batch returns the result. It no longer reports "delivered earlier" before the model sees the result.

Change the `bash` guidance: keep the default `yield_time_ms` for tests and builds. Lower it only for servers and watchers. Session data showed that a 1 s initial wait moved quick commands to the background, and the model then called `terminal_wait` at once.
