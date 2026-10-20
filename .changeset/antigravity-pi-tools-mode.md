---
"@tian.zuo/pi-antigravity": minor
---

Add `/agy-tools [on|off|status]`, `--agy-tools pi`, and `PI_ANTIGRAVITY_TOOLS=pi` to run a minimal custom Antigravity agent through Pi's MCP bridge. The slash command switches modes after the active run settles, preserves Pi history, and restores the previous mode if preparation fails. The mode exposes Pi's active builtin, extension, and MCP tools and relays Pi instructions, so tool calls use Pi's execution pipeline, hooks, and permissions. Session-owned agent configurations are cleaned up on exit; resumed Pi sessions rebuild the native conversation with the current bridge. Native tools remain the default mode.
