---
"@tian.zuo/pi-devin": minor
---

Initial release: Devin ACP provider extension for pi.

Registers `devin/*` models backed by `devin acp` (Agent Client Protocol over
stdio), preserving Devin's native server-side agent loop. Includes model
catalog discovery from `devin models list` with thinking-level resolution,
per-branch session persistence via `session/load`, streamed text/thinking,
display-only tool cards with result replay, permission prompts, Devin modes,
`/devin` commands (status/reset/sessions/mode/models/login/doctor), and usage
reporting.
