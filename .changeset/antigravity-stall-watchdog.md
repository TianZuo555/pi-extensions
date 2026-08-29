---
"@tian.zuo/pi-antigravity": patch
---

Detect and recover from stalled agy streams. A watchdog kills the turn when stdout/stderr produce no bytes for `AGY_STALL_TIMEOUT_MS` (default 120s; 300s while a tool step is ACTIVE, `0` disables), then resumes the conversation — or re-attempts the original prompt if stalled pre-init — with at most two retries instead of hanging until the 600s turn timeout. Once a terminal result is parsed, the stall watchdog is disarmed and resolves immediately without waiting for stdio close. Retries render as a collapsed "agy stream stalled … restarting the turn" thinking line, and turn budgets are now tunable via `AGY_TURN_TIMEOUT_MS` / `AGY_TOOL_STALL_TIMEOUT_MS` / `AGY_STALL_RETRY_BACKOFF_MS`.
