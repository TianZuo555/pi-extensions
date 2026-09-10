---
"@tian.zuo/pi-antigravity": patch
---

Detect running agy background tasks via process ancestry. agy 1.2.0 pipes task output through the agent process, so no task ever holds its `task-N.log` open and `/agy-tasks` listed live tasks as done (and refused to stop them). Scans now also match process-group-leading children of the live agy processes pi spawned, falling back to the existing log-holder and session-cwd orphan heuristics.
