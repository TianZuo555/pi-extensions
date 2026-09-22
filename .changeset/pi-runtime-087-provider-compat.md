---
"@tian.zuo/pi-antigravity": patch
"@tian.zuo/pi-compact": patch
"@tian.zuo/pi-commit": patch
"@tian.zuo/pi-devin-acp": patch
---

Support Pi 0.87's normalized provider transcripts and JSON-compatible tool calls. Custom providers now resolve system instructions from transcript messages without replaying them as conversation history, remote Responses compaction normalizes its provider context, and commit generation folds its system prompt into a transcript before calling the raw provider.
