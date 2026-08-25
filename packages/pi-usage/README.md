# @tian.zuo/pi-usage

Show **OpenAI Codex**, **GitHub Copilot**, **Z.ai (GLM Coding Plan)**,
**Z.ai Coding Plan (China)**, and **DeepSeek** account usage from inside the
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

Only metered quotas are shown. The unmetered `chat` and `completions` seat
buckets are omitted, and the premium bucket is labelled **Premium credits** on
credit-billed accounts (`token_based_billing`) and **Premium requests**
otherwise. GitHub may represent an organization-managed unlimited premium
bucket as a `0 / 0` snapshot with 100% remaining; that placeholder is shown as
**unlimited**, not as an empty quota.

## Commands

- `/usage` — open the usage menu. A cancellable loading spinner is shown while
  the provider endpoints are queried (press `Esc` to cancel). Pick **Refresh**
  to re-query, **Close** to dismiss. In non-interactive modes it prints a
  one-line summary instead.
- `/tokens` — local token/cost history recorded by pi itself, no provider
  calls. Shows a bar chart with a `1.2M tokens · $39.82` headline for **Today**
  (per hour), **Last 7 days**, **Last 30 days**, and **Month to date** (per
  day). Navigate with `←`/`→` (or `1`-`4`), toggle the chart metric with
  `Tab` (tokens ⇄ cost), rescan with `r`, close with `Esc`/`q`/`Enter`. In
  non-interactive modes it prints one summary line per window.

## Statusline

When the active model provider is Codex, Copilot, Z.ai, Z.ai Coding Plan
(China), or DeepSeek, the footer shows a compact Azure Blue meter such as
`codex 60% wk`, `copilot 31% credits`, `copilot 49% premium`, `zai 59% 5h`,
`zai-cn 82% 5h`, or `deepseek ¥27.00`, refreshed at most every five minutes
(results are cached to avoid hammering the endpoints).

## How /tokens works

pi records every assistant message's usage (input/output/cache tokens, total,
and list-price cost) in session files under `~/.pi/agent/sessions/` (or
`$PI_CODING_AGENT_DIR/sessions`). `/tokens` streams those JSONL files,
filters assistant messages with usage, and deduplicates by message id so
replayed or resumed copies (`repro.jsonl`, forks) are counted once. Files whose
name-encoded start date is more than 7 days older than the window are skipped;
non-standard names are always scanned. Cost is the model's list price recorded
at request time — subscription plans (Codex, Copilot, GLM Coding Plan) may
cover it, which the panel notes as *cost at list prices*.

## How it works

Credentials are read from the same store pi writes, `~/.pi/agent/auth.json`:

| Provider | Endpoint | Token used |
|----------|----------|------------|
| OpenAI Codex | `https://chatgpt.com/backend-api/wham/usage` | ChatGPT OAuth **access** token (pi resolves/refreshes it via the model registry, falling back to `auth.json`) |
| GitHub Copilot | `https://api.github.com/copilot_internal/user` | GitHub OAuth token (the `refresh` credential pi stores for `github-copilot`) |
| Z.ai (GLM Coding Plan) | `https://api.z.ai/api/monitor/usage/quota/limit` | Z.ai API key (the `key` pi stores for `zai`) |
| Z.ai Coding Plan (China) | `https://open.bigmodel.cn/api/monitor/usage/quota/limit` | China Coding Plan API key (the `key` pi stores for `zai-coding-cn`) |
| DeepSeek | `https://api.deepseek.com/user/balance` | DeepSeek API key (the `key` pi stores for `deepseek`) |

For Copilot, if pi has no stored credential the extension falls back to the
`GH_TOKEN` / `GITHUB_TOKEN` / `GITHUB_COPILOT_TOKEN` / `COPILOT_GITHUB_TOKEN`
environment variables and then to the VS Code Copilot credential file
(`~/.config/github-copilot/apps.json`).

For Z.ai, if pi has no stored key the extension falls back to the `ZAI_API_KEY`
environment variable. The quota endpoint reports each limit's `percentage` as
the share already **used** (so remaining is `100 - percentage`) and its
`nextResetTime` in epoch **milliseconds**; only the 5-hour token pool is shown
(as **5h tokens**) — the MCP/tool allowance and any other windows are ignored.

For Z.ai Coding Plan (China), the extension reads the `zai-coding-cn` key and
queries the domestic BigModel endpoint. If pi has no stored key, it falls back
to `ZAI_CODING_CN_API_KEY` and then `ZHIPU_API_KEY`. The monitor endpoint uses
the raw API key in its `Authorization` header (without `Bearer`); its quota
response has the same shape and percentage/reset semantics as the global
endpoint. When both the global and China plans resolve to the same API key,
`/usage` shows a single result for that account (preferring the active model's
region, then whichever query succeeded).

For DeepSeek, if pi has no stored key the extension falls back to the
`DEEPSEEK_API_KEY` environment variable. There is no percentage quota to meter:
the balance endpoint reports the account's money balance per currency
(`total_balance`, plus the `granted_balance` promotional credit and
`topped_up_balance` prepaid amount — API fees draw from granted first, then
topped up). The total is shown as a **Balance** window (e.g. `¥27.00` for CNY
or `$0.50` for USD), the nonzero parts of the breakdown as notes, and an
insufficient balance (`is_available: false`) is flagged in the report.

Provider requests allow up to 30 seconds per attempt and retry one transient
network, timeout, rate-limit, or server failure. Simultaneous startup and
`/usage` checks share the same in-flight request so they cannot race an OAuth
refresh or duplicate a cold request. Recorded expired Codex tokens are never
sent to the endpoint when Pi cannot refresh them.

Before calling a usage endpoint, `/usage` checks whether pi or one of the
supported fallback sources has login information for that provider. Providers
without login information are not fetched or displayed. If no provider is
configured, `/usage` asks you to sign in to at least one provider (or, for Z.ai,
export `ZAI_API_KEY` or `ZAI_CODING_CN_API_KEY`) before showing usage information.

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
