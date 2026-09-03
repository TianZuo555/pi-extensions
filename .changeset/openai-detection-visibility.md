---
"@tian.zuo/pi-web-search": patch
---

Fix OpenAI/Codex detection being invisible: add a `/web-search` status command (provider credentials + active search/fetch chains), list openai as a read-only auto-detected row in `/websearch-auth`, and warn when the stored `openai-codex` token has expired (re-run `/login`) instead of silently skipping it.
