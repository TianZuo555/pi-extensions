---
"@tian.zuo/pi-rex": minor
---

First published release.

Rex installs a SessionStart hook for Claude Code and Codex, but not for pi. This package supplies that hook. In a Rex terminal, it runs `rex __internal session-start --agent pi` when a session starts. It adds the output to the system prompt as a `<rex>` section, so pi knows its Rex session and pane without a search.

Set `rex.renameTab` to `true` in the pi settings to also tell pi to name the Rex tab. With tab naming on, the first tab of a session takes the session label and a later tab gets its own label.
