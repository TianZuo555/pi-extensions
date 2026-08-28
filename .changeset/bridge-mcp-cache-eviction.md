---
"@tian.zuo/pi-antigravity": patch
---

Evict agy's on-disk MCP tool-manifest cache (`~/.gemini/antigravity-cli/mcp/pi-bridge-*/`) when bridge registrations are pruned at startup and on session shutdown, so dead sessions no longer leak a manifest directory per session.
