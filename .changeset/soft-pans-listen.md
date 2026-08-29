---
"@tian.zuo/pi-image-cache": patch
---

Fix concurrent-session cleanup deleting freshly created cache directories by adding a 10-minute grace period, dispose the stale runtime on extension reload, clear the terminal display cache per session, evict display entries as a true LRU capped at 50, and separate model-facing placeholder strings into lib/prompt.ts.
