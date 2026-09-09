# @tian.zuo/pi-find

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
