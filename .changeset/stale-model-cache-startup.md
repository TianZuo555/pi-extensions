---
"@tian.zuo/pi-antigravity": patch
---

Never register Antigravity models from an expired on-disk model cache at startup. The cache was previously used unconditionally until an agy model was selected, so a stale cache written by an older extension version could pin a missing/outdated model list (e.g. hiding newly released models). Startup now registers from the fallback catalog baked into the installed build and heals to the live `agy models` list in the background, honoring the existing live (24h) and fallback (5min) TTLs.
