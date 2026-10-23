---
"@tian.zuo/pi-beautify-style": minor
---

Remove the bundled `cc-dark` and `cc-light` themes.

The package now renders entirely through the active Pi theme. Every color —
tool cards, diffs, reasoning, footer chips — comes from the theme's slots
(`toolSuccessBg`, `toolErrorBg`, `dim`, `accent`, …), so whichever theme you run
applies as-is.

`package.json` no longer declares `pi.themes` or ships a `themes/` directory.
If you selected `cc-dark` or `cc-light` from this package, switch to another
theme; those two names will not resolve after upgrading.
