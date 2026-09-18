---
"@tian.zuo/pi-usage": patch
---

Fix GLM Coding Plan (China) usage queries failing with "Z.ai usage endpoint returned no displayable data." The open.bigmodel.cn quota endpoint reports windows as `CREDIT_LIMIT` entries (the global api.z.ai uses `TOKENS_LIMIT`), which the parser did not recognize and dropped, leaving nothing to display. Both types are now labelled from their `unit`/`number` window encoding (5-hour and weekly windows for tokens or credits), and `CREDIT_LIMIT` windows additionally surface their absolute `remaining`/`usage` amounts (e.g. `1,930 / 2,000 credits`).
