---
"@tian.zuo/pi-antigravity": patch
---

Reap agy subprocess trees by process group instead of signaling only the direct child, and sweep every tracked group on exit and SIGHUP (terminal/pane close). A wedged `agy` no longer leaves orphaned processes behind when pi closes mid-call, and shutdown-path `agy mcp remove` now uses a 5-second budget so closing pi cannot stall on it.
