---
"@tian.zuo/pi-antigravity": patch
---

Preserve terminal results across incomplete-tool replay so Pi does not automatically resubmit the original command after a background-task timeout. Track emitted text across replay messages to avoid repeating the terminal response, emitting only a missing suffix and preserving streamed text on divergence.

Defensively recycle persistent agy processes when terminal results leave tools ACTIVE, including failed results, while retaining the conversation ID for subsequent user turns. Quarantine the driver immediately, allow its process group 500 ms to handle SIGTERM, then force cleanup of surviving processes before releasing queued turns. Keep cleanup tracked during shutdown. Unfinished commands may be cancelled; bridge handoff and incomplete-tool messages now explain this and recommend refreshing /agy-tasks before retrying, without promising that one-shot tasks stopped.

Improve empty-stderr diagnostics with model/conversation context and recovery options without assuming a cause.
