---
"@tian.zuo/pi-antigravity": patch
---

Slim the agy instruction relay down to pi's documentation block only, rebuilt from the installed pi package — pi-tool boilerplate, the duplicated skill catalog, workspace `AGENTS.md`/rules files agy discovers natively, and user-authored pi customizations no longer ride every fresh conversation. Summarization requests keep their own caller instructions instead of being overridden by the relay.

Restrict bridged skills to pi-private roots (`~/.pi/agent/skills`, `<project>/.pi/skills`, pi-package installs): shared `.agents` skill dirs are agy's own discovery domain or belong to other agents. When the pi-tool bridge is off or fails to register, the skill catalog is no longer injected into the prompt — the user gets a one-time warning that pi-private skills are unavailable.

Snapshot task-shaped agy children on every genuinely new `tool_start` step (repeated ACTIVE updates for the same step still skip the synchronous `ps` scan), so a worker spawned during a tool burst is recorded before an unexpected agy exit can orphan it.
