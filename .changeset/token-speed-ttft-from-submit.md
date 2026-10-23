---
"@tian.zuo/pi-token-speed": patch
---

Measure TTFT from prompt submission instead of from the assistant stream start.

`beginStream` runs on `message_start`, which is after Pi has already queued the request and run prefill. Subtracting that from the first delta measured only the delay inside the stream, so the footer reported values like `TTFT 1ms` while the user had actually waited over a second.

The extension now records the submission time on `before_agent_start` and uses it as the TTFT origin. The reported value matches what the user experiences and what `pi-beautify-style` shows for the same turn. When no submission timestamp exists — an SDK or RPC caller that never fired the event — it falls back to the previous behavior.
