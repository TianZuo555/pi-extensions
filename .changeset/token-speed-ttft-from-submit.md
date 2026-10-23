---
"@tian.zuo/pi-token-speed": patch
---

Measure TTFT from prompt submission, and use a Nerd Font glyph for the speed chip.

**TTFT.** `beginStream` runs on `message_start`, which is after Pi has already queued the request and run prefill. Subtracting that from the first delta measured only the delay inside the stream, so the footer reported values like `TTFT 1ms` while the user had actually waited over a second. The extension now records the submission time on `before_agent_start` and uses it as the TTFT origin. When no submission timestamp exists — an SDK or RPC caller that never fired the event — it falls back to the previous behavior.

**Glyph.** The `⚡` prefix on both the live rate and the end-of-turn summary is now `󰉁` (md-flash, `U+F0241`), matching the Nerd Font icons the rest of the footer uses.
