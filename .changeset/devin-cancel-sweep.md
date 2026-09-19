---
"@tian.zuo/pi-devin-acp": patch
---

Stop listing in-turn devin ops as running after a cancelled turn. When a
prompt is cancelled (pi-side `esc` or a superseding prompt) while devin
tool calls are in flight and no trailing terminal update ever arrives,
the entries stayed in the live-op tracker forever — the status bar kept
reporting `devin: N running` and `/devin-tasks` kept listing the dead
entries until each was dismissed by hand with `d`. A cancelled prompt's
in-turn ops (no background shell id) are now swept from the tracker
after a short grace window that lets devin's own trailing terminal
updates land first; swept ids are tombstoned so late re-notifications
cannot resurrect them, detached background shells stay listed, and a
newer turn's ops started inside the window are never touched.

Fixes #92
