---
"@tian.zuo/pi-devin-acp": patch
---

Prevent pending quota requests from restoring the Devin footer after a
model switch or session shutdown, while retaining account-wide caching
and request deduplication. Footer bookkeeping moves to a dedicated
`createDevinQuotaStatus` helper whose generation counter invalidates
older publications and rechecks the live provider after the await.
