---
"@tian.zuo/pi-beautify-style": patch
---

Let `@tian.zuo/pi-background-terminals` render its own tool cards.

The global tool patch took over `bash` and the three `terminal_*` tools because the exclusion list defaults to empty, so their own renderers were replaced by the generic ccstyle card. That dropped information the cards exist to show: the `terminal <id>` label and the `/ps to inspect` hint on a yielded command, the stdout preview, the changed-files note, and the settled/running breakdown on `terminal_wait`. A one-line command rendered as `4 lines returned` instead of its output.

Both packages now coexist without configuration. The `bash` override is recognized by its `yield_time_ms` parameter, which Pi's built-in bash does not declare; the three `terminal_*` names belong to that package alone.
