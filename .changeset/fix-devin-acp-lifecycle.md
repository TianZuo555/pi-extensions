---
"@tian.zuo/pi-devin-acp": patch
---

Fix cancellation and session replacement races during ACP startup, isolate restored session state, and preserve the accepted mode after invalid or rejected changes. Use unique replay tool IDs across Pi provider calls, honor thinking off, account for turn usage only once, and handle tools whose initial notification is already terminal. Queue task-stop requests as steering messages while Pi is running.
