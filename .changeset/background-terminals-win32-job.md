---
"@tian.zuo/pi-background-terminals": patch
---

Create a dedicated Windows Job Object before starting each background terminal, then use a pre-shell launcher to join the job before the requested Bash process can run. Closing the manager-owned `KILL_ON_JOB_CLOSE` handle now reaps the complete tree—including descendants re-parented after the shell exits—without a post-spawn assignment race. PID-based `taskkill /T` remains the first termination attempt.
