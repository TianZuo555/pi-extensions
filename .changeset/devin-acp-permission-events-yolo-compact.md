---
"@tian.zuo/pi-devin-acp": minor
---

Emit `agent:input_required` (and legacy `herdr:blocked`) on the shared event bus while a devin permission prompt waits on the user, so integrations such as Herdr can surface the blocked state and notification sound. Route every pi compaction trigger — manual `/compact`, threshold, and overflow recovery — to devin's own `/compact` instead of silently skipping non-manual ones, forwarding custom instructions and rate-limiting auto forwards. Add a persisted `yolo` setting (`/devin yolo on|off`, stored at `~/.pi/devin-acp/settings.json`) that pins devin to bypass mode and auto-approves any permission request that still arrives.
