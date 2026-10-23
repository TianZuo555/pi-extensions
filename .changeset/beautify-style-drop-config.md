---
"@tian.zuo/pi-beautify-style": minor
---

Remove runtime configuration.

The package no longer has a settings surface. Gone:

- the `/ccstyle` command (`on` / `compact` / `off` / `status` / `panel`)
- the six-tab settings panel (`extensions/config/panel.ts`)
- `~/.pi/agent/pi-beautify-style.json`, including the migration from
  `pi-cc-extensions.json` and `claude-code-style.json`

Every knob — render mode, diff layout, footer chips, reasoning preview length,
`@` reference features — is now a source constant in
`extensions/config/config.ts`. Edit that file and restart Pi to change
behavior. Any existing `pi-beautify-style.json` is ignored and can be deleted.

Render mode is fixed to `"on"` (Claude Code tool cards with rich diffs).
