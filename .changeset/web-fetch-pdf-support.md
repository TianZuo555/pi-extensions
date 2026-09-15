---
"@tian.zuo/pi-web-search": minor
---

Add PDF support to `web_fetch`. PDF responses are detected by Content-Type or the `%PDF-` magic bytes (including `application/octet-stream`), downloaded with a 20MB cap, and their text layer is extracted locally with unpdf — free, no provider credits. Pages are delimited with `<!-- Page N -->` markers and the new `maxPages` parameter (default 100) bounds the inline page count. When `maxPages` cuts a document short, the remaining pages are still extracted and the complete document is written to `~/.pi/web-search/fetches/` — the tool result points at the file path so no content is stranded. Extractions over ~200K chars are likewise persisted with a short preview inline.

For `.pdf` URLs the fetch chain now leads with `direct` (local extraction first, no credits), falling through to Firecrawl — whose `auto` parser mode applies OCR — for scanned documents or parse failures. Explicit `fetchProvider`/`fetchOrder` configuration disables the direct-first reordering. Firecrawl passes `maxPages` through to its per-page-priced PDF parser.

Fallback now also covers providers that *reach* a PDF but can't serve readable text: an Exa title-only stub counts as a failure, and any provider that returns raw PDF bytes (`%PDF-` header or NULs) as "text" is rejected so the chain walks on to a provider that actually parses the document.
