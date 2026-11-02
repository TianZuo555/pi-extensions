---
"@tian.zuo/pi-ask-user": patch
---

Report `blocked` to OSC 7501 terminals, such as Rex, while the TUI form waits for an answer.

Pi 1.5 lets an inline `ctx.ui.custom()` component pass `blocked: { kind, message }`. The form now passes the question label. Pi clears the status when the form closes and keeps the status of any dialog below it, so stacked dialogs no longer overwrite each other. Pi 1.4 ignores the option and shows the form without a blocked status.
