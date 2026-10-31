# @tian.zuo/pi-token-speed

## 0.1.2

### Patch Changes

- [#173](https://github.com/TianZuo555/pi-extensions/pull/173) [`5067811`](https://github.com/TianZuo555/pi-extensions/commit/506781181fdc1a9d5009278391312cdf8d47f6ae) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Move the runtime dependency to `effect@4.0.5` (from the `4.0.0-rc.117` release candidate), so installing this extension no longer pulls a pre-release Effect. `pi-usage` also picks up `playwriter@0.9.0` and `pi-web-search` `unpdf@1.9.1`. No API changes on the extension surface.

- [#175](https://github.com/TianZuo555/pi-extensions/pull/175) [`72bae03`](https://github.com/TianZuo555/pi-extensions/commit/72bae030f7cd50c233700caf1c09bb5f9af8c94c) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Measure TTFT from prompt submission, and use a Nerd Font glyph for the speed chip.
  
  **TTFT.** `beginStream` runs on `message_start`, which is after Pi has already queued the request and run prefill. Subtracting that from the first delta measured only the delay inside the stream, so the footer reported values like `TTFT 1ms` while the user had actually waited over a second. The extension now records the submission time on `before_agent_start` and uses it as the TTFT origin. When no submission timestamp exists — an SDK or RPC caller that never fired the event — it falls back to the previous behavior.
  
  **Glyph.** The `⚡` prefix on both the live rate and the end-of-turn summary is now `󰉁` (md-flash, `U+F0241`), matching the Nerd Font icons the rest of the footer uses.

## 0.1.1

### Patch Changes

- [#97](https://github.com/TianZuo555/pi-extensions/pull/97) [`57239e5`](https://github.com/TianZuo555/pi-extensions/commit/57239e5cd8f64238a6a576d436639eeb891deb85) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix an unbounded sample buffer in the live-rate sliding window: the head index never advanced, so the `> 512` trim never fired and every delta copied the whole array (O(n²) over a long stream). Samples are now pruned to the 5s window as they arrive, the dead `head` field is gone, and a `getWindowSampleCount` accessor plus regression test pin the bounded invariant.

## 0.1.0

- Changelog tracking was introduced after this release.
