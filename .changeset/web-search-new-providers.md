---
"@tian.zuo/pi-web-search": minor
---

pr: #122
author: @justin8ty

Add Brave (search), Parallel (search + fetch) and TinyFish (search + fetch) as web providers. Set `BRAVE_API_KEY`, `PARALLEL_API_KEY` or `TINYFISH_API_KEY` (or use `/websearch-auth`); they join the fallback chains after Monid and can be reordered with `/websearch-order`. Brave returns plain-text snippets, Parallel searches in `fast` mode, and TinyFish honours `raw`, accepts cached pages no older than two days (Firecrawl's default) and gives each page 30 s before the chain moves on. `<NAME>_BASE_URL` and `TINYFISH_FETCH_URL` override the endpoints.
