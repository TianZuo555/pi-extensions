---
"@tian.zuo/pi-web-search": patch
---

Stop the requested URL and target-site statuses from disabling providers. A fetch error that merely repeated the URL (`/issues/403`, `/Status/429`, `/credit-cards`) or the target's own HTTP status was read as a quota or rate-limit failure, so one such page took a provider out of the chain for the rest of the session — for search as well as fetch. The URL is now ignored when a failure is classified, and `direct`, which has no quota of its own, is never skipped.
