---
"@tian.zuo/pi-antigravity": patch
---

Evict agy's on-disk MCP tool-manifest cache (`~/.gemini/antigravity-cli/mcp/pi-bridge-*/`) when bridge registrations are pruned at startup and on session shutdown, so dead sessions no longer leak a manifest directory per session. Bridge registration state is now tracked separately from the HTTP listener, so failed agy MCP registration leaves direct skills visible and permits registration to retry on subsequent registration attempts (such as session resume or model re-selection).
