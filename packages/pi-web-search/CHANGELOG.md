# @tian.zuo/pi-web-search

## 0.5.0

### Minor Changes

- [#24](https://github.com/TianZuo555/pi-extensions/pull/24) [`5e0a1d1`](https://github.com/TianZuo555/pi-extensions/commit/5e0a1d1a64183eaf29ec76adc222eb8a55d0ad60) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Add `/websearch-order`: an interactive grab-and-move dialog to reorder the search fallback chain (enter grab, ↑↓ move, enter save, esc cancel). Saves the complete `searchOrder` in `~/.pi/web-search.json`; unconfigured providers keep their chosen position but are skipped until credentials become available. `/web-search` and `/websearch-auth` now point to it for reordering. The config file now lives at `~/.pi/web-search.json` (the old `~/.config/pi-web-search/config.json` is still read if present, and migrates on the next save).
  
  Also add `openai.reasoning` (`"low" | "medium" | "high"`, or `OPENAI_SEARCH_REASONING`): sets the Responses API reasoning effort for search calls. By default the effort now follows the session's pi thinking level (mapped through the model registry); with neither set the model default (medium) applies. `"low"` is ~40% faster in practice and usually plenty for search.

### Patch Changes

- [#24](https://github.com/TianZuo555/pi-extensions/pull/24) [`5e0a1d1`](https://github.com/TianZuo555/pi-extensions/commit/5e0a1d1a64183eaf29ec76adc222eb8a55d0ad60) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix OpenAI/Codex detection being invisible: add a `/web-search` status command (provider credentials + active search/fetch chains), list openai as a read-only auto-detected row in `/websearch-auth`, and warn when the stored `openai-codex` token has expired (re-run `/login`) instead of silently skipping it.

- [#24](https://github.com/TianZuo555/pi-extensions/pull/24) [`5e0a1d1`](https://github.com/TianZuo555/pi-extensions/commit/5e0a1d1a64183eaf29ec76adc222eb8a55d0ad60) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Attribute answer-only OpenAI searches to their internal source: when the Responses API answers from an internal tool (e.g. `oai-weather`, `oai-finance`) with no web URLs, the tool result now says `answer via openai (internal source: oai-weather)` and notes the internal source for the model, instead of showing a bare `0 results`.

## 0.4.0

- Changelog tracking was introduced after this release.
