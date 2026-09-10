---
"@tian.zuo/pi-antigravity": patch
---

Keep the persistent CLI's print wait above Pi's own turn deadline. When agy's default five-minute print wait expires mid-turn it reports `SUCCESS` with an empty response while the agent keeps working (`[agy] print timeout after 15s with turn in progress; returning partial output`), prematurely ending the Pi turn and dropping the final answer. Preserve distinct terminal answers instead of discarding them when they differ from streamed commentary, ignoring trailing-whitespace drift between agy's deltas and its result text so an already-rendered answer is never repeated.
