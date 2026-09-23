# @tian.zuo/pi-find

## 0.6.0

### Minor Changes

- [#112](https://github.com/TianZuo555/pi-extensions/pull/112) [`4fe40f8`](https://github.com/TianZuo555/pi-extensions/commit/4fe40f8f385c6b8031014efbc176edb714116d21) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Make search results more useful without expanding into a full shell interface.
  
  - Add grep file-only output using ripgrep's `-l` and literal matching.
  - Automatically include up to five surrounding lines for complete searches with one to three matching lines; use `read` for a wider window.
  - Group content by file, merge overlapping context, preserve late matches in clipped lines, and count only displayed results under the output budget.
  - Make slash-containing globs relative only to the search root, removing the previous cwd-relative alternative. For example, under `path: "src"`, use `deep/*.ts` for `src/deep`, not `src/deep/*.ts`.
  - Sort returned batches for readability and explain hidden-path defaults in empty results.
  - Report unreadable directories as partial results: grep no longer fails and discards its matches when rg meets a permission error, and find no longer passes such a walk off as complete.
  - Show empty-result hints only where they apply. A glob that repeats the search path gets a corrected suggestion (`try "**/*.ts"`), and hidden-path or file-size hints are omitted for hidden paths and explicit files. The grep pattern description mentions `(?i)` for case-insensitive search.
  - Add opt-in local debug logging via `PI_FIND_DEBUG` (off unless set) for studying real-world search outcomes: which limit bound, glob rejections, dropped context, typed errors vs aborts, stable notice IDs, and session/tool-call IDs for joining with the transcript. The log rotates at 10 MiB, and a `debug-stats` script summarizes it, including what the model did after empty or partial results.

## 0.5.0

### Minor Changes

- [#68](https://github.com/TianZuo555/pi-extensions/pull/68) [`4cfbbc6`](https://github.com/TianZuo555/pi-extensions/commit/4cfbbc603e1499803e897d6e44db21f6e13883c4) Thanks [@TianZuo555](https://github.com/TianZuo555)! - `find` now matches file names case-insensitively (`*.TS` finds `main.ts`, and `!*.TS` excludes it too). `grep` and its `glob` filter stay case-sensitive.

## 0.4.3

### Patch Changes

- [#59](https://github.com/TianZuo555/pi-extensions/pull/59) [`7f9c0b3`](https://github.com/TianZuo555/pi-extensions/commit/7f9c0b3a12c08eeeb3b06c71560356bc5077bdbc) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix three search defects found by comparing this extension against pi's built-in `grep` and against Codex and Grok Build.
  
  A glob written from the working directory now matches when `path` scopes the search: `{ "path": "src", "glob": "src/*.ts" }` used to return "No matches found." even though the built-in tool matched, because the glob was only matched relative to the search root. Slash globs now match relative to the search root *or* the working directory, and a leading `!` excludes instead of being treated as a literal, so `glob: "!*.test.ts"` (grep) and `pattern: "!**/*.generated.ts"` (find) work like ripgrep's own `--glob`.
  
  A match or path record larger than 8 MiB is now skipped instead of being buffered, and the result says so. Explicitly named files bypass ripgrep's `--max-filesize` traversal cap, and a 100 MiB single-line file used to peak at 866 MiB RSS because the whole JSON record was accumulated before decoding; the 30s wall-clock budget bounded time but not memory.

## 0.4.2

### Patch Changes

- [#46](https://github.com/TianZuo555/pi-extensions/pull/46) [`7e31102`](https://github.com/TianZuo555/pi-extensions/commit/7e311025a10e284646e662a082685fe695bbc018) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Simplify grep/find descriptions to search semantics and hidden-path defaults. Keep limits and timeout guidance in results, show JSON path decoding guidance only for quoted paths, and mention the traversal file-size cap only on empty grep results without timeout or truncation notices.

## 0.4.1

### Patch Changes

- [#42](https://github.com/TianZuo555/pi-extensions/pull/42) [`15d880f`](https://github.com/TianZuo555/pi-extensions/commit/15d880f6b539391da66cf7693b80f763b4736d81) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix root-relative glob matching without bypassing ignore rules, isolate grep from user ripgrep configuration, and report unexpected process termination as an error. Preserve unusual filenames with NUL-delimited find output and JSON-quoted display paths, and never surface partial records after a timeout kill. Normalize @ and home paths, reject explicit .git searches, retain empty-search timeout warnings, and document search limits. Add regression coverage for these behaviors and active cancellation.

## 0.4.0

### Minor Changes

- [#35](https://github.com/TianZuo555/pi-extensions/pull/35) [`4c46ca1`](https://github.com/TianZuo555/pi-extensions/commit/4c46ca1feec80e66ad2185d67b55fda54961cb1d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Harden grep/find against pathological searches: every rg/fd run now has a 30s wall-clock budget (SIGKILL on expiry, partial results kept with a "timed out, narrow the path" notice — never reported as a clean empty result), and rg skips files over 4MB during directory traversal so giant cache/bundle blobs can no longer turn a broad search into an overnight scan.

## 0.3.0

- Changelog tracking was introduced after this release.
