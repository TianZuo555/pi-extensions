---
"@tian.zuo/pi-web-search": minor
---

Add `/websearch-order`: an interactive grab-and-move dialog to reorder the search fallback chain (enter grab, ↑↓ move, enter save, esc cancel). Saves the result as `searchProvider` (head) + `searchOrder` in `~/.pi/web-search.json`; `/web-search` and `/websearch-auth` now point to it for reordering. The config file now lives at `~/.pi/web-search.json` (the old `~/.config/pi-web-search/config.json` is still read if present, and migrates on the next save).

Also add `openai.reasoning` (`"low" | "medium" | "high"`, or `OPENAI_SEARCH_REASONING`): sets the Responses API reasoning effort for search calls. By default the effort now follows the session's pi thinking level (mapped through the model registry); with neither set the model default (medium) applies. `"low"` is ~40% faster in practice and usually plenty for search.
