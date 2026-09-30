"@tian.zuo/pi-antigravity": patch
---

Bridge pi's built-in MCP tools instead of `pi-mcp-adapter` tools. `selectBridgedTools` now selects active tools whose source path is `builtin:mcp` (direct-exposure `mcp__<server>__<tool>` tools and the active MCP resource tools), so MCP servers reach agy through pi's native `mcp.json` support by setting `"exposure": "direct"`. Codemode/deferred tools stay pi-side: the bridge executes tools as model tool calls, which pi resolves against the active tool set. The third-party `pi-mcp-adapter` is no longer bridged (it replaces the built-in MCP support anyway). Fixes #131.
