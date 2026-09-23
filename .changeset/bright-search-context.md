---
"@tian.zuo/pi-find": minor
---

Make search results more useful without expanding into a full shell interface.

- Add grep file-only output using ripgrep's `-l` and literal matching.
- Automatically include up to five surrounding lines for complete searches with one to three matching lines; use `read` for a wider window.
- Group content by file, merge overlapping context, preserve late matches in clipped lines, and count only displayed results under the output budget.
- Make slash-containing globs relative only to the search root, removing the previous cwd-relative alternative. For example, under `path: "src"`, use `deep/*.ts` for `src/deep`, not `src/deep/*.ts`.
- Sort returned batches for readability and explain hidden-path defaults in empty results.
- Report unreadable directories as partial results: grep no longer fails and discards its matches when rg meets a permission error, and find no longer passes such a walk off as complete.
- Show empty-result hints only where they apply. A glob that repeats the search path gets a corrected suggestion (`try "**/*.ts"`), and hidden-path or file-size hints are omitted for hidden paths and explicit files. The grep pattern description mentions `(?i)` for case-insensitive search.
- Add opt-in local debug logging via `PI_FIND_DEBUG` (off unless set) for studying real-world search outcomes: which limit bound, glob rejections, dropped context, typed errors vs aborts, stable notice IDs, and session/tool-call IDs for joining with the transcript. The log rotates at 10 MiB, and a `debug-stats` script summarizes it, including what the model did after empty or partial results.
