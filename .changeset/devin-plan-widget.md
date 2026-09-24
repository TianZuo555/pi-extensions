---
"@tian.zuo/pi-devin-acp": minor
---

Show Devin's `todo_write` task list as a live checklist widget above the editor instead of synthetic thinking blocks in the transcript. The tool's state arrives as ACP `plan` updates; each update replaces the widget (`todo_write 2/5`, ✓ done / ◉ in progress / ○ pending) and the widget clears when the Devin session binding resets (`/devin reset`, session switch, leaving the Devin provider). The latest task list follows a restorable Pi session binding across reloads even though Devin's `session/load` does not replay ACP `plan` updates; attaching an unrelated Devin session clears the old tasks. The footer status now shows only `fast:on|off|n/a` — the selected model is already displayed by pi itself.
