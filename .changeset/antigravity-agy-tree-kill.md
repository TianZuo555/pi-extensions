---
"@tian.zuo/pi-antigravity": patch
---

Reap agy subprocess trees with cross-platform tree cleanup (process group on POSIX, taskkill on Windows) instead of signaling only the direct child, make death hooks reload-safe, and sweep every tracked group on exit, SIGHUP, and at the end of session shutdown without terminating the host process so Pi's async graceful shutdown is not preempted. A wedged `agy` no longer leaves orphaned processes behind when pi closes mid-call, and shutdown-path `agy mcp remove` now uses a 5-second budget so closing pi cannot stall on it.
