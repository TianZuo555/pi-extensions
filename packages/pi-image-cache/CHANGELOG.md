# @tian.zuo/pi-image-cache

## 0.1.2

### Patch Changes

- [#15](https://github.com/TianZuo555/pi-extensions/pull/15) [`59a2c0e`](https://github.com/TianZuo555/pi-extensions/commit/59a2c0e11f2c48f8db42cb2a0f8fe7f8a57c1052) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix concurrent-session cleanup deleting freshly created cache directories by adding a 10-minute grace period, dispose the stale runtime on extension reload, clear the terminal display cache per session, evict display entries as a true LRU capped at 50, and separate model-facing placeholder strings into lib/prompt.ts.

## 0.1.1

### Patch Changes

- [#7](https://github.com/TianZuo555/pi-extensions/pull/7) [`c160eaa`](https://github.com/TianZuo555/pi-extensions/commit/c160eaac7ba17055d8324f3e609e036d189bf66a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Detect temp-directory sources through native real paths, so clipboard images under a Windows 8.3 short path are still recognized as temporary.

## 0.1.0

- Changelog tracking was introduced after this release.
