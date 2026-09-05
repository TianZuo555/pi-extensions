# @tian.zuo/pi-find

## 0.4.0

### Minor Changes

- [#35](https://github.com/TianZuo555/pi-extensions/pull/35) [`4c46ca1`](https://github.com/TianZuo555/pi-extensions/commit/4c46ca1feec80e66ad2185d67b55fda54961cb1d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Harden grep/find against pathological searches: every rg/fd run now has a 30s wall-clock budget (SIGKILL on expiry, partial results kept with a "timed out, narrow the path" notice — never reported as a clean empty result), and rg skips files over 4MB during directory traversal so giant cache/bundle blobs can no longer turn a broad search into an overnight scan.

## 0.3.0

- Changelog tracking was introduced after this release.
