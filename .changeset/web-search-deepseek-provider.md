---
"@tian.zuo/pi-web-search": minor
---

Add DeepSeek as a search provider using the official server-side `web_search` tool on DeepSeek's Responses API. Credentials are auto-detected from your pi DeepSeek login, then `DEEPSEEK_API_KEY`, then `/websearch-auth`. Agentic multi-round search with a synthesized answer; ranks after OpenAI in the search fallback chain; `deepseek.model`/`deepseek.reasoning` (default `low`) configurable in `~/.pi/web-search.json`.
