# @tian.zuo/pi-compact-output

## 0.2.0

### Minor Changes

- [#163](https://github.com/TianZuo555/pi-extensions/pull/163) [`41fc9dd`](https://github.com/TianZuo555/pi-extensions/commit/41fc9ddb10d1b0711ede13962dbc1ced64685b3a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Support every Pi build whose TUI still exposes the prototype members the patch replaces — including Pi 1.x — by replacing the hand-maintained `0.83.x–0.87.x` version allowlist with a capability probe.
  
  The allowlist had gone stale: it was last widened in 0.1.2 (pi 0.87.x) and never updated for pi 0.99, 1.2, or 1.3, so the extension silently installed in no-op mode and rendered nothing but a warning while the TUI internals it patches were unchanged. It was not caught because the test asserting the gate derived its expectation from the installed `VERSION`, so it passed for every version, and 29 other tests returned early when the patch failed to install. Those guards now assert installation instead of skipping, so a future incompatible Pi build fails the suite instead of disabling the extension quietly.
  
  `isSupportedPiVersion` is removed; `installUiPatches()` reports incompatibility through `reason` when a required prototype member is missing.

## 0.1.2

### Patch Changes

- [#103](https://github.com/TianZuo555/pi-extensions/pull/103) [`09ffcc1`](https://github.com/TianZuo555/pi-extensions/commit/09ffcc1a46be322022adc08034dccd9c323af120) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Support Pi 0.87.x — the TUI internals pi-compact-output patches are unchanged, so the version gate now accepts 0.86.x/0.87.x in addition to 0.83.x–0.85.x.

## 0.1.1

### Patch Changes

- [#69](https://github.com/TianZuo555/pi-extensions/pull/69) [`359bc27`](https://github.com/TianZuo555/pi-extensions/commit/359bc27998779d23d60756ecc4bf2dc04be5b4d7) Thanks [@dependabot](https://github.com/apps/dependabot)! - Support Pi 0.85.x — the TUI internals pi-compact-output patches are unchanged, so the version gate now accepts 0.85.x in addition to 0.83.x/0.84.x.

## 0.1.0

- Changelog tracking was introduced after this release.
