---
"@tian.zuo/pi-background-terminals": minor
---

Assign each background terminal to a dedicated Windows Job Object with `KILL_ON_JOB_CLOSE`, so the whole process tree — including descendants re-parented after the shell exited while still holding the inherited stdio pipes — is reaped reliably on settle, kill, and crash. PID-based `taskkill /T` remains as a graceful first attempt; the job close is the kernel-level backstop.
