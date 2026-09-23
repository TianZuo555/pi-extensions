---
"@tian.zuo/pi-find": minor
---

Make search results more useful without expanding into a full shell interface.

- Add grep file-only output using ripgrep's `-l` and literal matching.
- Automatically include up to five surrounding lines for complete searches with one to three matching lines; use `read` for a wider window.
- Group content by file, merge overlapping context, preserve late matches in clipped lines, and count only displayed results under the output budget.
- Make slash-containing globs relative only to the search root, removing the previous cwd-relative alternative. For example, under `path: "src"`, use `deep/*.ts` for `src/deep`, not `src/deep/*.ts`.
- Sort returned batches for readability and explain hidden-path defaults in empty results.
- Add opt-in local debug logging via `PI_FIND_DEBUG` for studying real-world search outcomes.
