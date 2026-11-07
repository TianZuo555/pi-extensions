---
"@tian.zuo/pi-rex": patch
---

Fix three problems in the resume hook install. The bash block now uses POSIX syntax, so a `/bin/sh` that reads `.profile` can parse it. The Windows PowerShell 5.1 profile goes to `Documents\WindowsPowerShell`. Turning `rex.resume` off removes the pane's record, so the hook does not reopen the session.
