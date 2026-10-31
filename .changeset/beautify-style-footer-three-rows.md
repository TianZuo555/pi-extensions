---
"@tian.zuo/pi-beautify-style": patch
---

Lay the footer out in three fixed rows so plugin chips never crowd the location
line.

Row 1 keeps the builtin statistics (model, context, cache, rate, cost). Row 2
keeps the location (cwd, session name, branch) plus the MCP server count, which
this package draws itself. Row 3 collects every other extension's `setStatus()`
text, including `pi-usage`.

Before this change, plugin chips were appended to row 2 next to the cwd and
branch, and any `usage`/`quota`/`balance` key went to row 1. The footer grew
sideways as extensions registered status text. Now the first two rows stay
stable and row 3 is the only one that flexes. Row 3 stays hidden while no plugin
publishes text, so the footer still shrinks to two rows when quiet.

Remove the line-assignment helpers (`moveFooterKeyToLine`, `shiftFooterKeyLine`,
`reorderFooterKey`, `toggleFooterKeyHidden`, `resolveFooterChipLayout`,
`normalizeFooterChipLayout`, `defaultFooterLine`) and the `footerLine1Keys` /
`footerLine2Keys` / `footerLine3Keys` config fields. They existed for a settings
panel this package no longer has, and the rows are no longer user-assigned.
`footerHiddenKeys` stays: it still hides a plugin chip on row 3.

The MCP chip no longer enters the plugin channel. It is location information,
so it sits on row 2 next to the branch, and a third-party `mcp` status still
suppresses the builtin one to avoid a duplicate chip.
