---
"@tian.zuo/pi-background-terminals": patch
---

Reap redirected POSIX descendants on natural exit and shutdown, prevent pre-spawn cancellation from executing commands, and scope terminal/archive IDs to a unique runtime so stale references cannot read unrelated logs.

Fix UTF-8 spill paging and window bounds, and pause live following immediately when scrolling through either retained or archived output. Keep disk paging available when pausing before the initial window loads or when retention overflows during a pause. Classify aborted spawns as unsafe for fallback. Centralize model-facing errors, correct documentation, and add regression coverage with forced test exit disabled.
