---
"@tian.zuo/pi-beautify-style": minor
---

Remove the custom startup header.

The package no longer paints its own banner over Pi's built-in header, and the `showStartupHeader` option is gone from the config file, the `/ccstyle panel`, and `/ccstyle status`. Any local `showStartupHeader` value is ignored on load.

This frees the `ctx.ui.setHeader()` slot for whichever extension the user actually wants there — this repo's `welcome` extension, for example — instead of competing with it.
