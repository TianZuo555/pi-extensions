---
"@tian.zuo/pi-devin-acp": patch
---

Relay only the "Pi documentation" section of pi's instruction snapshot
to devin instead of the whole snapshot. The rest describes pi's own tool
surface (wrong for devin's tools) or duplicates what devin already loads
itself — AGENTS.md rules, user skills, the session cwd — so it was dead
context weight on every prompt. The doc paths are the one part devin
cannot discover alone; when the section is absent the full snapshot is
still sent as a fallback.
