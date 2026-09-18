---
"@tian.zuo/pi-devin-acp": patch
---

Restore pi's live footer stats during devin turns via per-message delta billing.

Previously usage was attached only to the turn's terminal assistant message, so pi's built-in footer (`↑ ↓ R CH $`) showed nothing for the whole duration of a devin turn. The turn controller now tracks the turn's billable token total and each pi assistant message (replay segment or terminal) persists only the not-yet-billed share: the footer fills live while the session log still sums to the authoritative total.

Accounting follows the real ACP wire protocol: each internal request's `usage_update` is emitted twice identically and `PromptResponse.usage` echoes the last request, so request snapshots accumulate after consecutive-identical dedup; `_cognition.ai/turn_stats` cumulative sums remain authoritative — they replace the accumulated total and block later request-level snapshots. Failed or aborted turns bill only the observed remainder.

Stop forwarding pi's auto-compaction triggers to devin. Because the merged turn usage inflated the context gauge past 100%, pi's threshold check kept firing and each forwarded `/compact` forced an unnecessary devin compaction. Only a manual `/compact` still routes to devin's own `/compact`; threshold and overflow triggers are vetoed silently — devin compacts itself internally and reports it via `compaction_update`.
