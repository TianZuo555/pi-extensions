---
"@tian.zuo/pi-beautify-style": patch
---

Fix review findings.

- Every tool uses the beautify card, including the `bash` and `terminal_*` tools from `@tian.zuo/pi-background-terminals`. Only `Agent` keeps its own renderer.
- A settled tool title no longer gets wider than the terminal when it renders again. On a narrow terminal the extra width made Pi stop with "Rendered line exceeds terminal width".
- The `write` override is installed only in TUI sessions. Print and headless sessions keep the `write` tool that is already registered.
- Session shutdown always removes this installation's patches, and the next session installs them again. A newer installation's sticky-prompt patches are no longer removed by an older shutdown.
- `setStatus("token-speed")` from `@tian.zuo/pi-token-speed` fills the footer rate chip instead of adding a second rate chip.
- `setStatus("usage")` from `@tian.zuo/pi-usage` fills the usage chip and is shown once.
- The `@subagent:[name]` delegation instruction is sent only when an `Agent` tool exists. An unreadable entry in `~/.pi/agent/agents` is skipped instead of failing the handler.
- Syntax highlighting does not try again on every repaint for a language that failed.
- The `/clear` and `/exit` aliases are removed.
- The unused `lib/our-tools.ts` helpers and their exports are removed.
