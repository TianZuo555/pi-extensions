---
"@tian.zuo/pi-antigravity": patch
---

Detect running agy background tasks via process ancestry. agy 1.2.0 pipes task output through the agent process, so no task ever holds its `task-N.log` open and `/agy-tasks` listed live tasks as done (and refused to stop them). Scans now also match process-group-leading children of the live agy processes pi spawned, falling back to the existing log-holder and session-cwd orphan heuristics. Ownership is never guessed, because stopping a task signals its whole process group and a wrong guess would kill a sibling task's work: processes already tied to a task by the authoritative log-holder scan (and everything sharing their process group) are excluded from the ancestry and orphan fallbacks, and processes that cannot be resolved to a single task — `ps` start times are only second-resolution — are reported as `unclear` instead of being attributed by proximity.
