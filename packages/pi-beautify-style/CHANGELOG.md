# @tian.zuo/pi-beautify-style

## 0.1.0

Forked from `@tian.zuo/pi-compact-output`, which this package replaces.

- Vendors the Claude Code-style TUI from `minuque/pi-cc-extensions` (MIT) as
  `extensions/`, including tool cards, rich diffs, compact mode, the footer,
  `/context`, `@` references, fullscreen mouse interaction, and the bundled
  `cc-dark`/`cc-light` themes.
- `ask_user` from `@tian.zuo/pi-ask-user` now renders through the upstream
  answer-tree card, including `choice: { label, wasCustom }` answers and the
  question-count suffix.
- `terminal_wait`, `terminal_stop`, and `terminal_log_read` from
  `@tian.zuo/pi-background-terminals` render as shell-style cards with a live
  elapsed timer and the terminal id in the title.
- The footer treats `setStatus("usage")` — the key used by
  `@tian.zuo/pi-usage` — as the usage chip. Upstream only recognized
  `pi-usage`/`localUsage`.
- Settings moved to `~/.pi/agent/pi-beautify-style.json`. Existing
  `pi-cc-extensions.json` and `claude-code-style.json` files are migrated on
  first load.
- Drops the old `pi-compact-output` prototype patch; `mode: "compact"` covers
  its collapsed tool blocks and reasoning summaries.
