---
"@tian.zuo/pi-beautify-style": patch
---

Keep the input box in place when a block collapses.

In regular TUI mode the whole frame is one line buffer: transcript, then the input dock (status line, editor, footer). When a block inside the viewport got shorter — the reasoning window shrinking from five rows to the `Thought for …` row, or a tool card collapsing — the renderer moved the whole tail up, so the input box jumped a few rows and left blank rows at the bottom.

The regular-mode patch now adds the lost rows as blank filler just above the input dock, and moves the hardware cursor by the same offset. The dock keeps its screen rows; the gap appears at the end of the transcript and new output fills it again. Sessions with a transcript shorter than the terminal no longer jump at the end of every reasoning pass.

The patch finds the dock by the editor block that the editor rendered in the same frame. Multi-line input that contains a pasted shell prompt (`  ❯ npm test`) no longer splits the input box.
