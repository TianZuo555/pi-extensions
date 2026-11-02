# @tian.zuo/pi-image-cache

## 0.1.3

### Patch Changes

- [#173](https://github.com/TianZuo555/pi-extensions/pull/173) [`5067811`](https://github.com/TianZuo555/pi-extensions/commit/506781181fdc1a9d5009278391312cdf8d47f6ae) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Move the runtime dependency to `effect@4.0.5` (from the `4.0.0-rc.117` release candidate), so installing this extension no longer pulls a pre-release Effect. `pi-usage` also picks up `playwriter@0.9.0` and `pi-web-search` `unpdf@1.9.1`. No API changes on the extension surface.

## 0.1.2

### Patch Changes

- [#15](https://github.com/TianZuo555/pi-extensions/pull/15) [`59a2c0e`](https://github.com/TianZuo555/pi-extensions/commit/59a2c0e11f2c48f8db42cb2a0f8fe7f8a57c1052) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix concurrent-session cleanup deleting freshly created cache directories by adding a 10-minute grace period, dispose the stale runtime on extension reload, clear the terminal display cache per session, evict display entries as a true LRU capped at 50, and separate model-facing placeholder strings into lib/prompt.ts.

## 0.1.1

### Patch Changes

- [#7](https://github.com/TianZuo555/pi-extensions/pull/7) [`c160eaa`](https://github.com/TianZuo555/pi-extensions/commit/c160eaac7ba17055d8324f3e609e036d189bf66a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Detect temp-directory sources through native real paths, so clipboard images under a Windows 8.3 short path are still recognized as temporary.

## 0.1.0

- Changelog tracking was introduced after this release.
