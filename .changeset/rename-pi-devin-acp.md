---
"@tian.zuo/pi-devin-acp": patch
---

Renamed the package from `@tian.zuo/pi-devin` to `@tian.zuo/pi-devin-acp` before its first npm publish — the directory, legacy stub (`extensions/pi-devin-acp.ts`), session-state entry key (`pi-devin-acp-session-state`), and state dir (`~/.pi/devin-acp/`) moved with it; existing `pi-devin-session-state` bindings are not migrated. Provider name (`devin`), models (`devin/*`), and commands (`/devin …`) are unchanged.
