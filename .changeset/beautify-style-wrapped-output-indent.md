---
"@tian.zuo/pi-beautify-style": patch
---

Keep wrapped output readable and group headers clickable.

- Wrapped tool output keeps the source indentation on every row. Indented `stdout`, JSON dumps, and nested lists used to fall back to the card edge after a line break, which made the continuation look like a separate line. Deep indents are clamped to half the width so text stays readable.
- A narrow tool-group header truncates the title and counts, never the expand hint. In fullscreen mode the hint is the click target, so cutting it made the whole card unclickable.
- `terminal_log_read` is removed from the background-terminal summary table. `@tian.zuo/pi-background-terminals` no longer registers that tool.
