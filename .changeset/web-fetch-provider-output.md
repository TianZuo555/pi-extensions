---
"@tian.zuo/pi-web-search": patch
---

Include the successful provider in model-visible `web_fetch` results, matching `web_search` provider attribution. Previously the provider appeared only in UI details, so the agent could not identify it. Page, raw HTML/text, PDF, and fallback results now name the provider without changing their fetched content.
