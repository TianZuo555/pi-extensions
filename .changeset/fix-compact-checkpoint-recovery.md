---
"@tian.zuo/pi-compact": patch
---

Preserve existing opaque checkpoints when remote compaction fails, is disabled, or cannot replay them instead of falling back to a lossy native summary. Keep checkpoint replay enabled independently of new compaction, allow cross-model replay on the same Codex backend, and reject the unavailable Codex compact-API route locally.

Forward custom compaction instructions, bound the entire remote request including SSE body reading, and allow recovery after transient route failures. Add an outer cancellation guard for unexpected settings/model/UI errors, quiet optional marker rewriting on ambiguous payloads, narrower HTTP error-code matching, and a once-per-route reminder when a disabled route falls back to native compaction. Add checkpoint lifecycle, exception-boundary, and transport regression tests.
