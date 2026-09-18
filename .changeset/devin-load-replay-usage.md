---
"@tian.zuo/pi-devin-acp": patch
---

Fix stale usage snapshots being billed to the wrong devin turn. A turn's activity feed now starts when its `session/prompt` goes out: until then the session listener stays state-only (updates still refresh the `/devin-usage` snapshot but never reach the turn). Previously the listener was wired to the fresh turn during session setup, so pre-prompt updates — the `session/load` replay tail carrying the loaded session's stored `usage_update` snapshot, or a superseded turn's trailing update — seeded the turn's `lastUsage` with prior-turn totals, and a turn aborted or failed before devin reported live usage persisted them again, double-counting tokens in pi's session log and `/tokens` history. As a bonus, replayed compaction notices can no longer render a phantom "devin compacted context" block into a turn's first message.
