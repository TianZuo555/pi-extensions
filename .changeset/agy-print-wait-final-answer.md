---
"@tian.zuo/pi-antigravity": patch
---

Keep the persistent CLI's print wait above Pi's own turn deadline. Agy's default five-minute wait can return a successful empty or partial result while schedules and final responses are still running, prematurely ending the Pi turn. Preserve distinct terminal answers instead of discarding them when they differ from streamed commentary, while avoiding already-rendered final-answer duplicates.
