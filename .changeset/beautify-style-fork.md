---
"@tian.zuo/pi-beautify-style": minor
---

Add `@tian.zuo/pi-beautify-style`, a Claude Code-style TUI for pi, replacing `@tian.zuo/pi-compact-output`.

The rendering stack — tool cards, rich diffs, compact mode, the footer, `/context`, `@` session/subagent references, fullscreen mouse interaction, and the bundled `cc-dark`/`cc-light` themes — is vendored from `minuque/pi-cc-extensions` (MIT) so this repository owns it. Install it instead of `npm:pi-cc-extensions`; both patch `ToolExecutionComponent` and must not run together.

This repo's extensions are wired in:

- `ask_user` renders through the upstream answer-tree card, including `choice: { label, wasCustom }` answers and the question-count suffix.
- `terminal_wait`, `terminal_stop`, and `terminal_log_read` render as shell-style cards with a live elapsed timer and the terminal id in the title.
- The footer treats `setStatus("usage")` as the usage chip, so `@tian.zuo/pi-usage` no longer renders an empty slot.

Settings moved to `~/.pi/agent/pi-beautify-style.json`; existing `pi-cc-extensions.json` and `claude-code-style.json` files are migrated on first load.
