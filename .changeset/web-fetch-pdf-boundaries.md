---
"@tian.zuo/pi-web-search": patch
---

Fix PDF fetch boundary handling: sniff before clipping large response chunks, accept PDFs exactly at the download limit, and keep non-PDF responses within the text byte cap without quadratic UTF-8 truncation. Honor cancellation and timeouts during page extraction, release PDF.js resources on success, failure, or cancellation, and avoid writing cancelled extractions to disk. Make the PDF spill-path test portable to Windows.
