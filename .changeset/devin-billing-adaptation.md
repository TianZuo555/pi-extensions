---
"@tian.zuo/pi-devin-acp": patch
---

Calculate costs from the original Devin token counters before adapting
aggregate usage for pi's overflow heuristic, and cap aggregated uncached
input as well: the shift previously ran before pricing (repricing moved
tokens at the cacheWrite rate) and was capped at cacheRead, so a
mostly-uncached aggregate still exceeded the context window and tripped
spurious compaction. Token totals are preserved; the synthetic counters
must not be used to recalculate costs.
