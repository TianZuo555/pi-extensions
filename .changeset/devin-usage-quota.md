---
"@tian.zuo/pi-devin-acp": patch
---

Show the account quota Devin CLI's `/usage` reports at the top of `/devin-usage`.

`/devin-usage` only rendered the session snapshot devin pushes over ACP, and ACP has no pull-based quota request — so the daily/weekly quota windows, reset times, and extra-usage balance were invisible from pi. The report now also calls `SeatManagementService/GetUserStatus` (the same Connect RPC Devin CLI's `/usage` uses) with the `windsurf_api_key` from `~/.local/share/devin/credentials.toml`, and renders a leading Quota section in devin's own wording: `0% used · resets in 19h 1m` for the daily window, `19% used · resets Sep 20, 4:00 PM (UTC+8)` for the weekly one, `Extra usage balance  $10.00`, and the `No quota consumed yet in this session.` tail on fresh sessions. Fetch failures degrade to a `Quota: unavailable — <reason>` row instead of hiding the section; the session view (context bar, tokens/cost, last-turn stats) is unchanged below it.
