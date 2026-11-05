---
"@tian.zuo/pi-rex": minor
---

Resume pi in its Rex pane after a Rex restart. In TUI mode, the extension records the pi session of each Rex pane in `~/.pi/agent/rex-resume/<block id>`. The record stays when pi stops because of SIGHUP, SIGTERM, or a lost terminal, and it is removed when you quit pi. A shell hook, shown in the README for fish, reads the record when Rex starts a new shell in the restored pane and runs `pi --session <file>`.
