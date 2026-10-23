---
"@tian.zuo/pi-beautify-style": patch
---

Render reasoning text with the theme's `thinkingText` slot instead of `dim`.

`thinkingText` is Pi's dedicated "Thinking block text color" — Pi's own thinking renderer uses it — so reasoning now follows whatever the active theme sets for it. The `Thought for 6s` heading and the `N more lines` hint stay on `dim`, which keeps them reading as metadata rather than content.
