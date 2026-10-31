---
"@tian.zuo/pi-beautify-style": patch
---

Clip the long session and branch names in the footer.

`footerLabelClip` (default 16) limits the session name and the branch name. A longer name keeps its head and ends with `…`, so `fix/beautify-style-review` shows as `fix/beautify-sty…`. The change stats after the branch name do not move. Set it to `0` to show the full names.
