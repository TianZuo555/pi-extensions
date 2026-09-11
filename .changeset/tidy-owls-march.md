---
"@tian.zuo/pi-antigravity": minor
---

Add `/agy-subagents`: a zero-token roster of agy subagent activity folded from the stream (invoke_subagent/run_subagent/define_subagent/browser_subagent spawns, send_message counts, manage_subagents kills), reset together with the conversation. agy has no read-only subcommand for live subagent state — `/subagents` in print mode burns a model turn — so the extension tracks the tool steps itself.

Flatten the `/agy` subcommands into top-level commands: `/agy reset|models|agents|doctor` are now `/agy-reset`, `/agy-models`, `/agy-agents`, `/agy-doctor` (consistent with `/agy-tasks`, `/agy-artifacts`, `/agy-usage`). Bare `/agy` still shows status and points at the new names when given arguments.
