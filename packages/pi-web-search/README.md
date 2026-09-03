# @tian.zuo/pi-web-search

Web search and web fetch for the [pi coding agent](https://pi.dev). Two tools,
six providers plus a built-in keyless fetcher, automatic fallback — no single
point of failure. **Works with zero configuration** thanks to Firecrawl's
keyless tier (search + fetch, no signup).

> **Token-light by design.** The whole extension adds **196 characters** of
> model-facing text — two tool descriptions of one sentence each. For
> comparison, [pi-web-access](https://www.npmjs.com/package/pi-web-access)
> spends ≈3,200 characters on its `web_search` tool alone (1,853-char
> description + parameter guidance) — **~16× our entire prompt surface**, across
> 4 tools vs our 2. All the routing intelligence (fallback orders, keyless
> ladders, quota handling) lives in extension code, not in the prompt, so the
> model spends its attention on your code instead of reading tool manuals.

## Configuration

**Easiest — `/websearch-auth` + `/websearch-order`** inside a pi session.

`/websearch-auth`: pick a provider, paste your key, done — or skip it
entirely: keyless Firecrawl is the default, no key needed.

```text
 Configure provider:

 → openai    ✓ auto: pi login (openai-codex)
   exa       • unconfigured
   firecrawl ✓ keyless (1,000 free credits/mo)
   tavily    • unconfigured
   monid     • unconfigured
   ollama    • unconfigured (default localhost:11434)
```

`/websearch-order`: grab a provider with `enter`, move it with `↑↓`, `enter` to
save — or do nothing and the default chain (keyless Firecrawl first) applies:

```text
 Search provider order

 ↑↓ navigate • enter grab • esc cancel

 → openai    ✓ ~/.pi/agent/auth.json (openai-codex)
   exa       ✓ EXA_API_KEY env
   firecrawl ✓ FIRECRAWL_API_KEY env (overflow after keyless credits)
   ollama    ✓ default localhost
   tavily    • unconfigured
   monid     • unconfigured
```

**Manual** — env variables:

| Variable                         | Unlocks                                                                                                                                    |
| :------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                 | OpenAI search — your pi Codex/OpenAI login is used first; this key is only a fallback                                                      |
| `EXA_API_KEY`                    | Exa search + fetch                                                                                                                         |
| `FIRECRAWL_API_KEY`              | Firecrawl search + fetch — optional: without a key, the keyless tier is used (1,000 free credits/mo; set `FIRECRAWL_KEYLESS=0` to disable) |
| `TAVILY_API_KEY`                 | Tavily search **and** fetch — one key unlocks both tools (fetch uses Tavily Extract)                                                       |
| `MONID_API_KEY`                  | Monid search + fetch — TinyFish endpoints via api.monid.ai, $0/call                                                                        |
| `OLLAMA_HOST` / `OLLAMA_API_KEY` | Ollama (default `http://localhost:11434`)                                                                                                  |

…or `~/.pi/web-search.json` for non-secret options. Every key is optional — omit
what you don't need:

A maximal example (defaults shown for `searchOrder`/`fetchOrder` are just
illustration — the real default is the canonical order filtered by what's
credentialed):

```json
{
  "searchProvider": "exa",
  "fetchProvider": "firecrawl",
  "searchOrder": ["tavily", "exa", "firecrawl"],
  "fetchOrder": ["exa", "tavily", "direct"],
  "openai": {
    "model": "gpt-5.6-luna",
    "baseUrl": "https://api.openai.com/v1/responses",
    "systemPrompt": "Search the web. Answer concisely and accurately; cite sources with Markdown links.",
    "reasoning": "low"
  },
  "exa": { "baseUrl": "https://api.exa.ai" },
  "firecrawl": { "baseUrl": "https://api.firecrawl.dev/v2", "keyless": true },
  "tavily": { "baseUrl": "https://api.tavily.com" },
  "ollama": { "baseUrl": "http://localhost:11434" },
  "monid": { "baseUrl": "https://api.monid.ai" }
}
```

`openai.reasoning` is optional: without it the search call follows the
session's thinking level (via pi's model registry), falling back to the model
default; set `"low"` to always search ~40% faster.

Prefer the interactive route? `/websearch-order` writes `searchProvider` +
`searchOrder` for you, and `/websearch-auth` manages Ollama's base URL — no
hand-editing needed.

## Commands

| Command            | Description                                                                                                                                                                 |
| :----------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/web-search`      | Show provider status: detected credentials (incl. auto-detected OpenAI) and the active search/fetch fallback chains                                                         |
| `/websearch-order` | Interactively reorder the search fallback chain: enter grab • ↑↓ move • enter save • esc cancel (saved as `searchProvider` + `searchOrder`)                                 |
| `/websearch-auth`  | Interactive credential setup (Exa / Firecrawl / Tavily / Monid / Ollama). OpenAI is listed read-only — it's auto-detected from your pi `/login` (Codex) or `OPENAI_API_KEY` |
| `/websearch-usage` | Show this session's per-provider usage (calls, failures, avg latency), providers on cooldown/blocked, and your Monid wallet balance with recent run costs                   |

## The tools

### `web_search`

Queries live web sources and returns ranked results with links and snippets.
OpenAI and Tavily additionally return a synthesized summary (shown as
`## Summary`).

- **Firecrawl** (default): live SERP results, keyed or keyless (1,000 free
  credits/mo without a key; `FIRECRAWL_KEYLESS=0` to opt out).
- **OpenAI**: server-side web search via the Responses API with a simple prompt;
  uses your active pi login (`openai-codex` / `openai`) first, falling back to
  `OPENAI_API_KEY`.
- **Exa / Tavily / Firecrawl / Monid / Ollama**: native API calls. Exa, Tavily,
  Firecrawl, and Monid keys each power **both** search and fetch.
- **Monid** (TinyFish via [api.monid.ai](https://monid.ai), $0/call):
  browser-rendered search — never-cached results with snippets and dates.

### `web_fetch`

Reads web pages as clean Markdown.

- **Firecrawl** (`/v2/scrape`, `onlyMainContent` on): keyed or
  [keyless](https://www.firecrawl.dev/blog/firecrawl-keyless-launch) — a real
  browser renders the page, so it succeeds where plain HTTP clients are
  bot-blocked or starved of JavaScript. **Exa** (`/contents`), **Tavily**
  (`/extract`, markdown format), **Monid** (TinyFish `/fetch`: real-browser
  rendering, clean Markdown), **Ollama** (`/api/web_fetch`): native scrapers.
- **Direct fetch** (the keyless fallback): plain HTTP GET, then main-content
  extraction with [Defuddle](https://github.com/kepano/defuddle) (the engine
  behind Obsidian Web Clipper) — navigation, sidebars, and cookie banners are
  removed before Markdown conversion. If Defuddle finds no usable main content
  (SPAs, tiny fragments), it falls back to a built-in regex-based converter.
  Pass `raw: true` to get the untouched response body instead.

## License

MIT

## Workflow

```mermaid
flowchart TB
    Call["web_search / web_fetch"] --> Pref["start at your\npreferred provider"]
    Pref --> Try{"try provider"}
    Try -- "success" --> Done["return result\n(+ which providers\nit fell back from)"]
    Try -- "quota failure\n(402/403, credits,\nusage limit)" --> Skip["skip provider for\nthe whole session"]
    Skip --> Next1{"more providers\nin chain?"}
    Try -- "rate limit (429)" --> Cooldown["cooldown ~2 min"]
    Cooldown --> Next2{"more providers\nin chain?"}
    Next1 -- "yes" --> Try
    Next2 -- "yes" --> Try
    Next1 -- "no" --> Fail["error listing\nall failures"]
    Next2 -- "no" --> Fail
```

## Release notes

[changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-web-search/CHANGELOG.md)
· [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)
