---
"@tian.zuo/pi-devin-acp": minor
---

`/devin tasks` is now the standalone command `/devin-tasks` with /ps-style overlay interaction: `enter` opens a read-only detail view for the selected devin operation (invocation info tab with id/title/kind/tool/status/elapsed/scope/locations/input, plus a live `output` tab that tails devin's streamed tool output with j/k scrolling, page keys, and g/G), and `x` requests a stop. Previously both keys jumped straight to the kill confirmation. When an operation settles while being inspected, the view freezes on its last snapshot and stops offering kill; killing still only applies to detached background shells, which pi can only ask devin to stop.

Also fixes a process leak: devin background shells are detached into their own process groups and used to survive `/new`, `/quit`, and `/reload` as orphaned processes after the `devin acp` child was killed — still running, but invisible to `/devin-tasks` and unreachable by the fresh session. The runtime now kills those detached descendant groups (SIGTERM, then SIGKILL) before the acp child dies; the child's own process group, shared with pi, is never signalled. POSIX only — Windows falls back to a best-effort `taskkill /T` tree kill.
