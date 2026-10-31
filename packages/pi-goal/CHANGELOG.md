# @tian.zuo/pi-goal

## 0.2.2

### Patch Changes

- [#173](https://github.com/TianZuo555/pi-extensions/pull/173) [`5067811`](https://github.com/TianZuo555/pi-extensions/commit/506781181fdc1a9d5009278391312cdf8d47f6ae) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Move the runtime dependency to `effect@4.0.5` (from the `4.0.0-rc.117` release candidate), so installing this extension no longer pulls a pre-release Effect. `pi-usage` also picks up `playwriter@0.9.0` and `pi-web-search` `unpdf@1.9.1`. No API changes on the extension surface.

## 0.2.1

### Patch Changes

- [#135](https://github.com/TianZuo555/pi-extensions/pull/135) [`13a214e`](https://github.com/TianZuo555/pi-extensions/commit/13a214e070e011709c642b2ee9d36f45e6915535) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Mark pi-goal deprecated and document how to remove it. Keep its source for historical reference, stop loading it from the root extension bundle, and remove its test script and root test shortcut so local workspace runs and CI skip its archived tests.

## 0.2.0

- Changelog tracking was introduced after this release.
