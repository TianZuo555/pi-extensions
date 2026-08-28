---
"@tian.zuo/pi-subagents": patch
---

Resolve the worktree subdirectory through native real paths, so a subagent on Windows no longer works in a path derived from git's slash-normalized, 8.3 short-name output.
