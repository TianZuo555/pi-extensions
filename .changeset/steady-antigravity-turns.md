---
"@tian.zuo/pi-antigravity": patch
---

Restore Pi history on the first Antigravity handoff while preserving explicit reset behavior, relay and synchronize Pi instructions through agy's text interface without dropping pending instruction or skill updates on stall retries, prevent cancelled startup from submitting prompts, and track overlapping native tool steps correctly. Enforce a single logical-turn deadline across startup, retries, and backoff, and clarify that native agy operations bypass Pi's permission hooks.
