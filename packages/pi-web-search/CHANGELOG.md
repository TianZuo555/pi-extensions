# @tian.zuo/pi-web-search

## 0.9.0

### Minor Changes

- [#96](https://github.com/TianZuo555/pi-extensions/pull/96) [`b40b81c`](https://github.com/TianZuo555/pi-extensions/commit/b40b81c9e25f293bcc3602276bbe9c25039d6226) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fetch plain-text document, data/config, and source-file URLs (`.md`, `.txt`, `.json`, `.yaml`, `.csv`, `.py`, `.ts`, …) with `direct` first, mirroring the existing `.pdf` direct-first rule: those bodies are served as `text/*` and returned verbatim, so scraper providers only added cost and the risk of reformatting. Server-rendered page suffixes (`.php`, `.asp`, `.jsp`, …) keep the canonical order, and explicit `fetchProvider`/`fetchOrder` settings still disable the reordering.

## 0.8.1

### Patch Changes

- [#75](https://github.com/TianZuo555/pi-extensions/pull/75) [`50e035c`](https://github.com/TianZuo555/pi-extensions/commit/50e035cf03a6cc16ef2d5e6881c9ed4b654b2435) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix web_search and web_fetch result rendering for failed tool calls: an error result used to fall through to the success summary and print "✓ NaN KB via undefined". Failed calls now render a ✗ line with the first error message line (e.g. "All fetch providers failed:") and, when expanded, the full per-provider failure list.

## 0.8.0

### Minor Changes

- [#67](https://github.com/TianZuo555/pi-extensions/pull/67) [`8a037ff`](https://github.com/TianZuo555/pi-extensions/commit/8a037ff3d64d17bf2d75573430e40405231a4c46) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Add PDF support to `web_fetch`. PDF responses are detected by Content-Type or the `%PDF-` magic bytes (including `application/octet-stream`), downloaded with a 20MB cap, and their text layer is extracted locally with unpdf — free, no provider credits. Pages are delimited with `<!-- Page N -->` markers and the new `maxPages` parameter (default 100) bounds the inline page count. When `maxPages` cuts a document short, the remaining pages are still extracted and the complete document is written to `~/.pi/web-search/fetches/` — the tool result points at the file path so no content is stranded. Extractions over ~200K chars are likewise persisted with a short preview inline.
  
  For `.pdf` URLs the fetch chain now leads with `direct` (local extraction first, no credits), falling through to Firecrawl — whose `auto` parser mode applies OCR — for scanned documents or parse failures. Explicit `fetchProvider`/`fetchOrder` configuration disables the direct-first reordering. Firecrawl passes `maxPages` through to its per-page-priced PDF parser.
  
  Fallback now also covers providers that *reach* a PDF but can't serve readable text: an Exa title-only stub counts as a failure, and any provider that returns raw PDF bytes (`%PDF-` header or NULs) as "text" is rejected so the chain walks on to a provider that actually parses the document.

### Patch Changes

- [#67](https://github.com/TianZuo555/pi-extensions/pull/67) [`8a037ff`](https://github.com/TianZuo555/pi-extensions/commit/8a037ff3d64d17bf2d75573430e40405231a4c46) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix PDF fetch boundary handling: sniff before clipping large response chunks, accept PDFs exactly at the download limit, and keep non-PDF responses within the text byte cap without quadratic UTF-8 truncation. Honor cancellation and timeouts during page extraction, release PDF.js resources on success, failure, or cancellation, and avoid writing cancelled extractions to disk. Make the PDF spill-path test portable to Windows.

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
