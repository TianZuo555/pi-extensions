---
"@tian.zuo/pi-ask-user": patch
---

Report `blocked` to OSC 7501 terminals, such as Rex, while the TUI form waits for an answer.

Pi reports `blocked` only for its built-in `select`, `input`, and `editor` dialogs. The `ask_user` form uses `ctx.ui.custom()`, so Rex showed no status while the form was open. The form now writes `blocked` (`kind=question`, with the question label as the message) when it opens. When it closes, it restores the `working` status that Pi reported for the run.
