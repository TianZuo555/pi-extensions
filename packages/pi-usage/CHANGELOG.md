# @tian.zuo/pi-usage

## 0.5.1

### Patch Changes

- [#173](https://github.com/TianZuo555/pi-extensions/pull/173) [`5067811`](https://github.com/TianZuo555/pi-extensions/commit/506781181fdc1a9d5009278391312cdf8d47f6ae) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Move the runtime dependency to `effect@4.0.5` (from the `4.0.0-rc.117` release candidate), so installing this extension no longer pulls a pre-release Effect. `pi-usage` also picks up `playwriter@0.9.0` and `pi-web-search` `unpdf@1.9.1`. No API changes on the extension surface.

## 0.5.0

### Minor Changes

- [#160](https://github.com/TianZuo555/pi-extensions/pull/160) [`90e8815`](https://github.com/TianZuo555/pi-extensions/commit/90e8815e864760f3dd61d934070d60d5c8db42e8) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Read provider usage from `magpie quota --json` first when magpie is installed, falling back to pi's own credentials per provider. magpie discovers the machine's agent sign-ins itself (Codex's auth.json, Copilot's keychain item, vendor API keys), so `/usage` keeps reporting Codex, Copilot, Z.ai/GLM and DeepSeek even when pi's stored credential is a magpie gateway placeholder or missing. `PI_USAGE_MAGPIE_BIN` overrides binary discovery.

### Patch Changes

- [#156](https://github.com/TianZuo555/pi-extensions/pull/156) [`9cba1b6`](https://github.com/TianZuo555/pi-extensions/commit/9cba1b6a9bb558e89e68ac65f52259084a25b8b8) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Display the legacy Codex quota meter for OpenAI models, assuming both logins use the same account. Reuse the Codex credential and cache, and show a legacy login hint when it is not configured.

## 0.4.2

### Patch Changes

- [#148](https://github.com/TianZuo555/pi-extensions/pull/148) [`f320be5`](https://github.com/TianZuo555/pi-extensions/commit/f320be5c57413aeb4e1243d3a9adb1b8e77b4148) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Read saved usage credentials from Pi’s configured agent directory, honoring `PI_CODING_AGENT_DIR` for DeepSeek and all other providers that share the auth reader. Report the actual auth file path in credential-source diagnostics.

## 0.4.1

### Patch Changes

- [#126](https://github.com/TianZuo555/pi-extensions/pull/126) [`d3a1ed0`](https://github.com/TianZuo555/pi-extensions/commit/d3a1ed0cef9a2fa37ef1343d66908a1cb4ae343b) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Point the Codex configure hint at the renamed **OpenAI Codex (legacy)** login and document it in the README: pi's `/login` → "Sign in with ChatGPT" on the `openai` provider issues an api.openai.com token that `chatgpt.com/backend-api/wham/usage` rejects (401), so only the `openai-codex` credential can report Codex usage.

- [#133](https://github.com/TianZuo555/pi-extensions/pull/133) [`ae1cf78`](https://github.com/TianZuo555/pi-extensions/commit/ae1cf7848c0afe57355ed1641dc346c473d6ecbf) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Count nested tool-result usage, standalone usage entries, and compaction/branch-summary usage in `/tokens` so the dashboard matches pi's session totals, including code-mode classifier calls.

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
