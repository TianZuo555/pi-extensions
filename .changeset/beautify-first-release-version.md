---
"@tian.zuo/pi-beautify-style": minor
---

First published release.

`@tian.zuo/pi-beautify-style` replaces `@tian.zuo/pi-compact-output` with a vendored Claude Code-style TUI: tool cards, rich diffs, a status footer, `/context`, `@session` and `@subagent` references, and integrations for this repository's `ask_user`, background-terminal, and usage extensions.

The rendering stack comes from `minuque/pi-cc-extensions` (MIT, see `ATTRIBUTION.md`), so this repository owns it. Install this package instead of `npm:pi-cc-extensions` — both patch `ToolExecutionComponent` and must not run together.

There is no runtime configuration. Render mode, diff layout, footer chips, and the reasoning preview length are source constants in `extensions/config/config.ts`. The package ships no theme files; every color comes from the active Pi theme.
