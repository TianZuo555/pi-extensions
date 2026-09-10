---
"@tian.zuo/pi-antigravity": patch
---

Stop relaying Pi's builtin tool inventory to agy. The instruction snapshot is written for a model holding Pi's tools, but agy runs its own native tool set and reaches Pi only through bridged MCP tools — `selectBridgedTools` never exposes a Pi builtin — so the `Available tools:` block described tools agy cannot call and spent prompt tokens on every conversation. Only Pi's own validated top-level block is dropped — it must precede any project context, contain `- name: description` bullets, and end with Pi's trailing caveat — so an `Available tools:` line inside project instructions (a deployment section listing terraform/kubectl, say) relays untouched along with all other guidance. Incomplete `schedule` replays also no longer point at `/agy-tasks`: agy runs schedule timers in-process, so they hold no task pid and the dashboard always renders them as done.
