---
"@tian.zuo/pi-devin-acp": patch
---

Register Devin model rows even when the CLI omits their pricing and context metadata, restoring `devin/swe-2` for catalogs that print its rows without metadata. Model catalogs cached by an older release are now refreshed automatically on the next session start instead of waiting for the 24-hour expiry.
