---
"@tian.zuo/pi-rex": minor
---

Add the `rex_worktree_move` tool. The agent calls it from codemode after it creates a git worktree. The tool opens a Rex session for the worktree, moves only the agent pane into it, and names the pane after the feature. When the turn ends, pi switches to the worktree, and the pi process changes to the worktree folder. The conversation stays. Each Rex app that showed the old session goes to the moved pane, when its Remote Control setting is on.

Remove the resume feature, because Rex now starts pi again in a restored pane. The `rex.resume` and `rex.resumeCommand` settings are removed. In a Rex pane, the extension removes the old shell hook and the records in `~/.pi/agent/rex-resume`. It removes only text that it wrote.
