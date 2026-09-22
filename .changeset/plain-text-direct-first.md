---
"@tian.zuo/pi-web-search": minor
---

Fetch plain-text document, data/config, and source-file URLs (`.md`, `.txt`, `.json`, `.yaml`, `.csv`, `.py`, `.ts`, …) with `direct` first, mirroring the existing `.pdf` direct-first rule: those bodies are served as `text/*` and returned verbatim, so scraper providers only added cost and the risk of reformatting. Server-rendered page suffixes (`.php`, `.asp`, `.jsp`, …) keep the canonical order, and explicit `fetchProvider`/`fetchOrder` settings still disable the reordering.
