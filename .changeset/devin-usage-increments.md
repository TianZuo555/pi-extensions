---
"@tian.zuo/pi-devin-acp": patch
---

Record ACP usage once on the terminal assistant message, preserving cache-read/cache-write classification and cost even when cache metadata arrives after tool replay segments. Failed and aborted streams retain their latest observed usage; summary sessions merge streamed usage with canonical prompt-response totals. Normalize nullable ACP cache counters and include cache writes without double counting input. Live usage remains available through /devin-usage; replay-only messages intentionally carry zero billable usage.
