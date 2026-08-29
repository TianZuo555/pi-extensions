# @tian.zuo/pi-usage

Release notes:
[changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-usage/CHANGELOG.md)
· [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

Show **OpenAI Codex**, **GitHub Copilot**, **Z.ai (GLM Coding Plan)**, **Z.ai
Coding Plan (China)**, and **DeepSeek** account usage from inside the
[pi coding agent](https://pi.dev), plus a `/tokens` dashboard of the token and
cost history pi records locally.

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
(China), or DeepSeek, the footer shows a compact Azure Blue meter such as
`codex 60% wk`, `copilot 31% credits`, `copilot 49% premium`, `zai 59% 5h`,
`zai-cn 82% 5h`, or `deepseek ¥27.00`, refreshed at most every five minutes
(results are cached to avoid hammering the endpoints).

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
