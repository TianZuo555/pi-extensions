---
"@tian.zuo/pi-beautify-style": patch
---

Show the collapsed reasoning card whenever `previewLines` is set, instead of only when Pi's `hideThinkingBlock` is on.

Upstream deferred to Pi's own Thinking Markdown renderer whenever the user kept thinking visible, so `previewLines` was silently inert for the default configuration: long reasoning streamed in full and kept scrolling the transcript. `previewLines > 0` now takes over the reasoning block regardless of `hideThinkingBlock`, so the preview window and the `N more lines` hint apply. `previewLines: 0` still leaves Pi's renderer in place.
