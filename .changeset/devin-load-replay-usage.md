---
"@tian.zuo/pi-devin-acp": patch
---

Fix devin turn usage being both double-counted and under-counted in pi's session log (and therefore `/tokens`).

- A turn's activity feed now starts when its `session/prompt` goes out: until then the session listener stays state-only (updates still refresh the `/devin-usage` snapshot but never reach the turn). Previously the listener was wired to the fresh turn during session setup, so pre-prompt updates — the `session/load` replay tail carrying the loaded session's stored `usage_update` snapshot, or a superseded turn's trailing update — seeded the turn's `lastUsage` with prior-turn totals, and a turn aborted or failed before devin reported live usage persisted them again, double-counting tokens.
- Billable usage now comes from `_cognition.ai/turn_stats` responseDimensions, whose cumulativeMetric rows sum every internal model request of the turn (devin's `usage_update`/`PromptResponse.usage` only report the last request, so multi-request turns were badly under-counted). Each `session/prompt` is stamped with a `cognition.ai/clientMessageId` that devin echoes as `turnClientMessageId`, so a turn claims only its own stats — replayed or superseded-turn stats can't contaminate it. Once cumulative sums land they are authoritative: trailing last-request snapshots merge without overwriting token fields.
