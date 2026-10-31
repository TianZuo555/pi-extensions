# @tian.zuo/pi-commit

## 0.1.3

### Patch Changes

- [#173](https://github.com/TianZuo555/pi-extensions/pull/173) [`5067811`](https://github.com/TianZuo555/pi-extensions/commit/506781181fdc1a9d5009278391312cdf8d47f6ae) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Move the runtime dependency to `effect@4.0.5` (from the `4.0.0-rc.117` release candidate), so installing this extension no longer pulls a pre-release Effect. `pi-usage` also picks up `playwriter@0.9.0` and `pi-web-search` `unpdf@1.9.1`. No API changes on the extension surface.

## 0.1.2

### Patch Changes

- [#103](https://github.com/TianZuo555/pi-extensions/pull/103) [`09ffcc1`](https://github.com/TianZuo555/pi-extensions/commit/09ffcc1a46be322022adc08034dccd9c323af120) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Support Pi 0.87's normalized provider transcripts and JSON-compatible tool calls. Custom providers now resolve system instructions from transcript messages without replaying them as conversation history, remote Responses compaction normalizes its provider context, and commit generation folds its system prompt into a transcript before calling the raw provider.

## 0.1.1

- Changelog tracking was introduced after this release.
