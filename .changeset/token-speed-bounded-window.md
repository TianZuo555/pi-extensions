---
"@tian.zuo/pi-token-speed": patch
---

Fix an unbounded sample buffer in the live-rate sliding window: the head index never advanced, so the `> 512` trim never fired and every delta copied the whole array (O(n²) over a long stream). Samples are now pruned to the 5s window as they arrive, the dead `head` field is gone, and a `getWindowSampleCount` accessor plus regression test pin the bounded invariant.
