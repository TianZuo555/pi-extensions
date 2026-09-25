# @tian.zuo/pi-usage

## 0.4.0

### Minor Changes

- [#111](https://github.com/TianZuo555/pi-extensions/pull/111) [`da74b09`](https://github.com/TianZuo555/pi-extensions/commit/da74b09383211616c12d1a56bf050c15769d63b1) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Add a consent-gated `/usage-mimo-sync` command that reads only the Xiaomi MiMo console session from a Playwriter-enabled browser tab after Xiaomi model login. Keep imported cookies in memory, never read browser cookies during background usage queries, and show actionable, redacted 401 guidance.

## 0.3.0

### Minor Changes

- [#109](https://github.com/TianZuo555/pi-extensions/pull/109) [`2f335f4`](https://github.com/TianZuo555/pi-extensions/commit/2f335f47e5ba77bdbe71d475faad2ff2b87542bb) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Add a **Xiaomi MiMo** provider showing the pay-as-you-go money balance exactly like DeepSeek (`Balance: ¥21.66` in `/usage`, `xiaomi ¥21.66` in the statusline). Xiaomi only exposes balance through its web console API (`platform.xiaomimimo.com/api/v1/balance`), which authenticates with Xiaomi account session cookies — the `sk-` model API key cannot query balance — so the credential is a console cookie stored as `xiaomi-console` in `~/.pi/agent/auth.json` (or exported as `MIMO_COOKIE`). The report shows the total balance as a monetary window with `Granted`/`Topped up` notes (gift vs. cash balance) and flags an insufficient balance.

## 0.2.1

### Patch Changes

- [#87](https://github.com/TianZuo555/pi-extensions/pull/87) [`b982e60`](https://github.com/TianZuo555/pi-extensions/commit/b982e6072f27a166642ec881bd77b750c78a01ce) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix GLM Coding Plan (China) usage queries failing with "Z.ai usage endpoint returned no displayable data." The open.bigmodel.cn quota endpoint reports windows as `CREDIT_LIMIT` entries (the global api.z.ai uses `TOKENS_LIMIT`), which the parser did not recognize and dropped, leaving nothing to display. Both types are now labelled from their `unit`/`number` window encoding (5-hour and weekly windows for tokens or credits), and `CREDIT_LIMIT` windows additionally surface their absolute `remaining`/`usage` amounts (e.g. `1,930 / 2,000 credits`).

## 0.2.0

### Minor Changes

- [#12](https://github.com/TianZuo555/pi-extensions/pull/12) [`d42073b`](https://github.com/TianZuo555/pi-extensions/commit/d42073b93cb10b43d92c4d174e8fc6fa0a80b76c) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Support top 10 models in the `/tokens` dashboard with up/down arrow and `j`/`k` scrolling.

## 0.1.2

- Changelog tracking was introduced after this release.
