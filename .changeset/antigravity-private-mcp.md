---
"@tian.zuo/pi-antigravity": patch
---

Isolate each Antigravity bridge with a private workspace MCP configuration passed only to its agy children. Both native and Pi tools modes use stable `pi__` tool names without modifying global MCP registrations. Keep descriptor caches scoped to a short unique server name, recycle drivers when private discovery changes, and clean up partial preparation, private credentials, and owned caches on teardown. Rebuild saved conversations from Pi history when their original bridge instance has been replaced.
