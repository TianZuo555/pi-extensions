# @tian.zuo/pi-token-speed

## 0.1.1

### Patch Changes

- [#97](https://github.com/TianZuo555/pi-extensions/pull/97) [`57239e5`](https://github.com/TianZuo555/pi-extensions/commit/57239e5cd8f64238a6a576d436639eeb891deb85) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix an unbounded sample buffer in the live-rate sliding window: the head index never advanced, so the `> 512` trim never fired and every delta copied the whole array (O(n²) over a long stream). Samples are now pruned to the 5s window as they arrive, the dead `head` field is gone, and a `getWindowSampleCount` accessor plus regression test pin the bounded invariant.

## 0.1.0

- Changelog tracking was introduced after this release.
