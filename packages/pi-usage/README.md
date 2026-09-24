# @tian.zuo/pi-usage

Release notes:
[changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-usage/CHANGELOG.md)
· [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

Show **OpenAI Codex**, **GitHub Copilot**, **Z.ai (GLM Coding Plan)**, **Z.ai
Coding Plan (China)**, **DeepSeek**, and **Xiaomi MiMo** account usage from
inside the [pi coding agent](https://pi.dev), plus a `/tokens` dashboard of the
token and cost history pi records locally.

`/usage` opens a menu with the current usage for every configured provider, and
a compact meter is shown in the footer whenever the active model belongs to a
supported provider.

```text
OpenAI Codex · Plus
  5h limit:         [████████████████░░░░] 78% left · resets 14:20 on 27 Jul

  Weekly limit:     [████████████░░░░░░░░] 60% left · resets 09:00 on 2 Aug

GitHub Copilot · Business
  Premium credits:  [██████░░░░░░░░░░░░░░] 31% left · 7,787 / 25,000 credits
  Quota resets: 2026-08-01

GLM Coding Plan · Lite
  5h tokens:        [████████████░░░░░░░░] 59% left · resets 16:22

GLM Coding Plan (China) · Pro
  5h tokens:        [████████████████░░░░] 82% left · resets 18:05

DeepSeek
  Balance:          ¥27.00
  Topped up: ¥27.00

Xiaomi MiMo
  Balance:          ¥21.66
  Granted: ¥21.66
```

`/tokens` opens an interactive token and cost dashboard with an ASCII/Unicode
bar chart, peak breakdown, and scrollable model rankings (up to top 10 models):

```text
────────────────────────────────────────────────────────────────────
 tokens · local pi usage
 14 session files · dedup by message id

 1d [7d] 30d MTD
 ←/→ or h/l window · ↑/↓ or j/k scroll · 1-4 jump · Tab · Esc close
────────────────────────────────────────────────────────────────────
 Last 7 days (Aug 23 – Aug 29) · per day, tokens
 1.3M tokens · $41.27
 7 requests · in 892K · out 163K · cache 255K
 cost at list prices (subscription plans may cover it)

 peak 415K on Aug 25
       ██
       ██ ██
    ██ ██ ██    ██
    ██ ██ ██ ██ ██
 ██ ██ ██ ██ ██ ██ ██
 ██ ██ ██ ██ ██ ██ ██
 23    25    27    29

 top models by tokens (1–5 of 7 · ↑/↓ scroll)
   1. anthropic/claude-3-7-sonnet  747K  $25.62
   2. openai-codex/gpt-5.6  453K  $14.55
   3. zai/glm-4-plus  110K  $1.10
   4. google/gemini-2.5-pro  85K  $0.75
   5. deepseek/deepseek-chat  40K  $0.20
────────────────────────────────────────────────────────────────────
```

## Commands

- `/usage` — open the usage menu. A cancellable loading spinner is shown while
  the provider endpoints are queried (press `Esc` to cancel). Pick **Refresh**
  to re-query, **Close** to dismiss. In non-interactive modes it prints a
  one-line summary instead.
- `/tokens` — local token/cost history recorded by pi itself, no provider calls.
  Shows a bar chart with a `1.2M tokens · $39.82` headline for **Today** (per
  hour), **Last 7 days**, **Last 30 days**, and **Month to date** (per day).
  Navigate with `←`/`→` (or `1`-`4`), scroll top models with `↑`/`↓` (or
  `j`/`k`, up to top 10), toggle the chart metric with `Tab` (tokens ⇄ cost),
  rescan with `r`, close with `Esc`/`q`/`Enter`. In non-interactive modes it
  prints one summary line per window.

## Statusline

When the active model provider is Codex, Copilot, Z.ai, Z.ai Coding Plan
(China), DeepSeek, or Xiaomi MiMo, the footer shows a compact Azure Blue meter
such as `codex 60% wk`, `copilot 31% credits`, `copilot 49% premium`,
`zai 59% 5h`, `zai-cn 82% 5h`, `deepseek ¥27.00`, or `xiaomi ¥21.66`,
refreshed at most every five minutes (results are cached to avoid hammering the
endpoints).

## How /tokens works

pi records every assistant message's usage (input/output/cache tokens, total,
and list-price cost) in session files under `~/.pi/agent/sessions/` (or
`$PI_CODING_AGENT_DIR/sessions`). `/tokens` streams those JSONL files, filters
assistant messages with usage, and deduplicates by message id so replayed or
resumed copies (`repro.jsonl`, forks) are counted once. Files whose name-encoded
start date is more than 7 days older than the window are skipped; non-standard
names are always scanned. Cost is the model's list price recorded at request
time — subscription plans (Codex, Copilot, GLM Coding Plan) may cover it, which
the panel notes as _cost at list prices_.

## Xiaomi MiMo setup

Xiaomi MiMo's balance is only exposed by the web console API
(`platform.xiaomimimo.com/api/v1/balance`), which authenticates with **Xiaomi
account session cookies** — the `sk-` model API key you use for `/login` (and
for model calls) cannot query balance. The cookie is only needed for this
extension's usage display. First sign in to the Xiaomi model provider with
pi's `/login`; MiMo usage is not loaded for users without a Xiaomi login.

1. Log in at <https://platform.xiaomimimo.com/#/console/balance> and open the
   balance page (the one showing 账户余额 / Account Balance).
2. Open DevTools (`F12`, or `Cmd+Option+I` on macOS) → **Network** tab.
3. Refresh the page (`Cmd/Ctrl+R`) so the balance request is captured.
4. In the Network tab's filter box type `balance` — you should see a request
   named `balance` (`GET …/api/v1/balance`). Click it.
5. In **Headers** → **Request Headers**, find the `Cookie:` line. Right-click
   the value → **Copy value** (on older Chrome: select the whole line and copy).
   The parts that matter are `api-platform_serviceToken`, `api-platform_ph`,
   `api-platform_slh`, and `userId`; copying the entire header is fine.
6. Store it in pi's auth store, `~/.pi/agent/auth.json`, under the
   `xiaomi-console` entry (kept separate from the `xiaomi` api_key entry so
   `/login` never clobbers it):

```json
"xiaomi-console": { "type": "cookie", "key": "api-platform_serviceToken=…; api-platform_ph=…; api-platform_slh=…; userId=…" }
```

Alternatively export the same string as `MIMO_COOKIE` (the auth store entry
wins when both are set). Supplying the cookie manually is an explicit choice
to let `/usage` query Xiaomi's console balance endpoint with it.

### Optional browser sync

After signing in to the Xiaomi model provider with `/login`, open the
[MiMo console](https://platform.xiaomimimo.com/console/balance) in a browser
and enable the [Playwriter extension](https://playwriter.dev) on that tab.
Run `/usage-mimo-sync`. Pi explains why the console cookie is needed and asks
for consent **before reading it**. It validates the cookie with Xiaomi's
balance endpoint and holds it only in memory for this pi process; it never
prints or writes the imported cookie to `auth.json`. The command does not
inspect or navigate unrelated tabs. Ordinary `/usage` and background status
updates never read browser cookies.

MiMo is queried only when the Xiaomi model provider is logged in **and** a
console cookie is available. If the session expires, `/usage` reports a
specific 401 re-login instruction; sign in to the console again and run
`/usage-mimo-sync`, or repeat the manual steps above with a fresh cookie.

## Install

```bash
pi install npm:@tian.zuo/pi-usage
```

Try it without installing permanently:

```bash
pi -e npm:@tian.zuo/pi-usage
```

## License

[MIT](../../LICENSE) © Tian Zuo
