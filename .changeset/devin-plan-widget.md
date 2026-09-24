---
"@tian.zuo/pi-devin-acp": minor
---

Show Devin's task plan as a live checklist widget above the editor instead of `Plan` thinking blocks in the transcript. Devin's `todo_write` arrives as ACP `plan` updates; each update replaces the widget (`Plan 2/5`, ✓ done / ◉ in progress / ○ pending) and the widget clears when the Devin session binding resets (`/devin reset`, session switch, leaving the Devin provider). The latest plan follows a restorable Pi session binding across reloads even though Devin's `session/load` does not replay plans; attaching an unrelated Devin session clears the old plan. The footer status now shows only `fast:on|off|n/a` — the selected model is already displayed by pi itself.
