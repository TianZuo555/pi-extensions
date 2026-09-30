---
"@tian.zuo/pi-devin-acp": patch
---

Refresh an expired model cache in the background at session startup, even when another provider is selected, so newly shipped families appear in the model picker without running `/devin models` manually. Reuse an in-flight automatic refresh when a Devin model is selected during discovery, and avoid starting CLI processes when Pi only loads extensions.
