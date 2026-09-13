---
"@tian.zuo/pi-compact": patch
---

Preserve existing opaque checkpoints when remote compaction fails, is disabled, or cannot replay them instead of falling back to a lossy native summary. Keep checkpoint replay enabled independently of new compaction, allow cross-model replay on the same Codex backend, and reject the unavailable Codex compact-API route locally.

Forward custom compaction instructions, bound the entire remote request including SSE body reading, and classify route failures from the HTTP status the provider reported instead of guessing from message text. A route is abandoned for the session after three consecutive failures of any kind, repeated warnings are shown once, and unexpected handler failures cancel with a visible reason instead of failing silently.

Add `allowLossyNativeFallback` to opt into Pi's native summary when a compaction would otherwise be cancelled. Add checkpoint lifecycle, exception-boundary, route-classification, and transport regression tests.
