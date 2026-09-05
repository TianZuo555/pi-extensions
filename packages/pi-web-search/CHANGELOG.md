# @tian.zuo/pi-web-search

## 0.7.0

### Minor Changes

- [#29](https://github.com/TianZuo555/pi-extensions/pull/29) [`66de02a`](https://github.com/TianZuo555/pi-extensions/commit/66de02abf0491e5165a27a06c15658b44d3d8f62) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Simplify `/websearch-order` keybindings: **space** now grabs/drops an item and **enter** always saves immediately, so reordering no longer requires a second confirm keypress. `esc` still cancels.

- [#30](https://github.com/TianZuo555/pi-extensions/pull/30) [`a42e967`](https://github.com/TianZuo555/pi-extensions/commit/a42e967b10aea67e94438755a8b6ab9c7771de03) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Add DeepSeek as a search provider using the official server-side `web_search` tool on DeepSeek's Responses API. Credentials are auto-detected from your pi DeepSeek login, then `DEEPSEEK_API_KEY`, then `/websearch-auth`. Agentic multi-round search with a synthesized answer; ranks after OpenAI in the search fallback chain; `deepseek.model`/`deepseek.reasoning` (default `low`) configurable in `~/.pi/web-search.json`.

## 0.6.0

### Minor Changes

- [#27](https://github.com/TianZuo555/pi-extensions/pull/27) [`35a256d`](https://github.com/TianZuo555/pi-extensions/commit/35a256da3260d1140ad2a035508064303dd8835b) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Expand `/websearch-order` into a tabbed editor for both fallback chains. The dialog opens on Search and switches to Fetch with Tab, preserves edits across tabs, and saves complete `searchOrder` and `fetchOrder` arrays together. The Fetch tab uses the same grab-and-move controls and includes the built-in `direct` provider.

## 0.5.0

### Minor Changes

- [#24](https://github.com/TianZuo555/pi-extensions/pull/24) [`5e0a1d1`](https://github.com/TianZuo555/pi-extensions/commit/5e0a1d1a64183eaf29ec76adc222eb8a55d0ad60) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Add `/websearch-order`: an interactive grab-and-move dialog to reorder the search fallback chain (enter grab, ↑↓ move, enter save, esc cancel). Saves the complete `searchOrder` in `~/.pi/web-search.json`; unconfigured providers keep their chosen position but are skipped until credentials become available. `/web-search` and `/websearch-auth` now point to it for reordering. The config file now lives at `~/.pi/web-search.json` (the old `~/.config/pi-web-search/config.json` is still read if present, and migrates on the next save).
  
  Also add `openai.reasoning` (`"low" | "medium" | "high"`, or `OPENAI_SEARCH_REASONING`): sets the Responses API reasoning effort for search calls. By default the effort now follows the session's pi thinking level (mapped through the model registry); with neither set the model default (medium) applies. `"low"` is ~40% faster in practice and usually plenty for search.

### Patch Changes

- [#24](https://github.com/TianZuo555/pi-extensions/pull/24) [`5e0a1d1`](https://github.com/TianZuo555/pi-extensions/commit/5e0a1d1a64183eaf29ec76adc222eb8a55d0ad60) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix OpenAI/Codex detection being invisible: add a `/web-search` status command (provider credentials + active search/fetch chains), list openai as a read-only auto-detected row in `/websearch-auth`, and warn when the stored `openai-codex` token has expired (re-run `/login`) instead of silently skipping it.

- [#24](https://github.com/TianZuo555/pi-extensions/pull/24) [`5e0a1d1`](https://github.com/TianZuo555/pi-extensions/commit/5e0a1d1a64183eaf29ec76adc222eb8a55d0ad60) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Attribute answer-only OpenAI searches to their internal source: when the Responses API answers from an internal tool (e.g. `oai-weather`, `oai-finance`) with no web URLs, the tool result now says `answer via openai (internal source: oai-weather)` and notes the internal source for the model, instead of showing a bare `0 results`.

## 0.4.0

- Changelog tracking was introduced after this release.
