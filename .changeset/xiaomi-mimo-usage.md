---
"@tian.zuo/pi-usage": minor
---

Add a **Xiaomi MiMo** provider showing the pay-as-you-go money balance exactly like DeepSeek (`Balance: ¥21.66` in `/usage`, `xiaomi ¥21.66` in the statusline). Xiaomi only exposes balance through its web console API (`platform.xiaomimimo.com/api/v1/balance`), which authenticates with Xiaomi account session cookies — the `sk-` model API key cannot query balance — so the credential is a console cookie stored as `xiaomi-console` in `~/.pi/agent/auth.json` (or exported as `MIMO_COOKIE`). The report shows the total balance as a monetary window with `Granted`/`Topped up` notes (gift vs. cash balance) and flags an insufficient balance.
