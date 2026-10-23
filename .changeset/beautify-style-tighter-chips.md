---
"@tian.zuo/pi-beautify-style": patch
---

Tighten the git and rate chips.

The git chip dropped its parentheses: `(+12 −4)` is now ` +12/−4`, which reads as one token instead of a nested group. The rate chip replaced the `avg` prefix with the same md-flash glyph the rest of the footer uses, so `avg 211 tok/s` is now `󰉁 211 tok/s`. `live` keeps its word, since that mode has to stay distinguishable from the average.
