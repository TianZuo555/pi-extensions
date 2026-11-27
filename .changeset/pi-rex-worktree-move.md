---
"@tian.zuo/pi-rex": minor
---

Add the `rex_worktree_move` tool. The agent calls it from codemode after it creates a git worktree. The tool opens a Rex session for the worktree, moves the Rex tab into it, and switches pi to the worktree when the turn ends. The conversation stays.

Remove the resume feature, because Rex now starts pi again in a restored pane. The `rex.resume` and `rex.resumeCommand` settings are removed. In a Rex pane, the extension removes the old shell hook and the records in `~/.pi/agent/rex-resume`. It removes only text that it wrote.
