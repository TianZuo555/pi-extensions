---
"@tian.zuo/pi-compact": minor
---

Default compaction to GPT-6 Luna on the session provider. Keep opaque remote compaction for legacy Codex, and use Pi's text summarizer with a once-per-session warning for the new OpenAI Sign in with ChatGPT authentication, which rejects remote compaction. Preserve existing opaque checkpoints instead of silently replacing their history, and document text-summary cache behavior.
