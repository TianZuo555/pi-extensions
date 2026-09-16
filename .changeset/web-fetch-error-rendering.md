---
"@tian.zuo/pi-web-search": patch
---

Fix web_search and web_fetch result rendering for failed tool calls: an error result used to fall through to the success summary and print "✓ NaN KB via undefined". Failed calls now render a ✗ line with the first error message line (e.g. "All fetch providers failed:") and, when expanded, the full per-provider failure list.
