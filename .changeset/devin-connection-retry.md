---
"@tian.zuo/pi-devin-acp": patch
---

Surface Devin's backend reconnects in pi: the `devin acp` child emits a `_cognition.ai/connection_retry` notification per attempt while a prompt waits on its stream, which previously left pi's turn looking frozen with no explanation. The status-bar widget now shows `devin: connection failed (attempt N/M), retrying…` (or `connection lost` for mid-stream drops) with the elapsed retry time, clearing as soon as updates resume, the turn settles, or the state goes stale; `/devin` status reports the same retry state. Retries attributed to other ACP sessions are ignored.
