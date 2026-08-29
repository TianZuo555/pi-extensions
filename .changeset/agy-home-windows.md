---
"@tian.zuo/pi-antigravity": patch
---

Shorten home-directory paths in tool cards via `os.homedir()` instead of `$HOME`, so `~/...` also renders on Windows, where that variable is unset.
