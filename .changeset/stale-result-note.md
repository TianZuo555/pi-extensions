---
"@tian.zuo/pi-background-terminals": minor
---

Report files the model changed while a command was running.

A test that finishes after the code under test changed can report a pass for code that no longer exists, and nothing in the transcript says so. Successful `edit` / `write` calls are now recorded against every command running at that moment, and the final result — the completion message, `terminal_wait`, `terminal_stop`, or the `bash` result itself — states the fact:

```
Background terminal bt-… "pnpm test" exited (exit 0) after 2m10s.
Changed while this command ran: src/lib.ts, tests.rs. The result may not reflect those changes; run the command again if they matter to it.
```

Only paths inside the command's working directory are named. A change stays recorded across agent runs until the terminal leaves the 32-entry history, because a command can start in one run and settle in a later one. It is a note, not an action: nothing is re-run, no successful result becomes a failure, and no file dependencies are inferred. Changes made by shell commands (`sed -i`, `cargo fmt`, `git apply`) are not detected.
