---
"@tian.zuo/pi-devin-acp": minor
---

Rebuild `/devin tasks` as a `/ps`-style fullscreen overlay (mirroring the background-terminals dashboard): bordered op list with j/k selection, live 1 Hz refresh, elapsed times, background-shell markers, and enter/x to ask devin to kill a background shell; non-TUI modes keep the select/confirm flow. Fix the devin runtime dying with "ManagedRuntime disposed" after pi `/new`, `/resume`, or `/fork`: extensions are cached and reused across session replacement, so those now suspend the runtime (kill the `devin acp` child, drop the session binding) and only quit/`/reload` close it for good — `/new` now really starts a fresh devin session on the next turn.
