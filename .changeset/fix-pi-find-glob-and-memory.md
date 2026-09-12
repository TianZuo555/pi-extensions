---
"@tian.zuo/pi-find": patch
---

Fix three search defects found by comparing this extension against pi's built-in `grep` and against Codex and Grok Build.

A glob written from the working directory now matches when `path` scopes the search: `{ "path": "src", "glob": "src/*.ts" }` used to return "No matches found." even though the built-in tool matched, because the glob was only matched relative to the search root. Slash globs now match relative to the search root *or* the working directory, and a leading `!` excludes instead of being treated as a literal, so `glob: "!*.test.ts"` (grep) and `pattern: "!**/*.generated.ts"` (find) work like ripgrep's own `--glob`.

A match or path record larger than 8 MiB is now skipped instead of being buffered, and the result says so. Explicitly named files bypass ripgrep's `--max-filesize` traversal cap, and a 100 MiB single-line file used to peak at 866 MiB RSS because the whole JSON record was accumulated before decoding; the 30s wall-clock budget bounded time but not memory.
