---
"@tian.zuo/pi-beautify-style": patch
---

Stream reasoning in a five-row window, hide it when the run ends, and open it
with `ctrl+t`.

While a thinking run streams, the card shows at most `liveThinkingLines`
(default `5`) rows. Newer reasoning pushes older rows up out of the window, so
the block stays a stable height instead of growing down the transcript.

When the run finishes (text or a tool call follows), the body is hidden
completely. Only one row remains: `Thought for 8s · ctrl+t to expand`, or
`Thought for 8s · click to show more` in fullscreen.

`ctrl+t` (`app.thinking.toggle`) expands every finished thinking card to its
full text and keeps new cards expanded, the same way Pi's own toggle works.
Press it again to hide the bodies. Clicking one card while the toggle is on
collapses only that card. Selector and dialog screens keep their own `ctrl+t`
(for example the `/tree` filter).

`previewLines` is renamed to `liveThinkingLines` because it now sizes the live
window, not a finished preview. This package also always owns the reasoning
block now; Pi's own renderer used to stay in place whenever `hideThinkingBlock`
was off, which made the setting silently inert.
