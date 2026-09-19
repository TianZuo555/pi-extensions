---
"@tian.zuo/pi-devin-acp": patch
---

Show the account quota in the footer status line while a Devin model is
selected (`devin 100% day 81% wk`, refreshed with a 60s cache on session
start, model select, and turns — same convention as the pi-usage
extension), and report real context occupancy in `usage.totalTokens`
instead of summed internal-request usage. The summed prompts could exceed
the model window on multi-request segments, tripping pi's auto-compaction
threshold (and silent-overflow heuristic) and printing
"Auto-compaction cancelled" on every vetoed attempt; the occupancy signal
keeps the context gauge truthful while the session_before_compact veto
stays as the guardrail for genuinely full contexts.
