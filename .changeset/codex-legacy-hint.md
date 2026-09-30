---
"@tian.zuo/pi-usage": patch
---

Point the Codex configure hint at the renamed **OpenAI Codex (legacy)** login and document it in the README: pi's `/login` → "Sign in with ChatGPT" on the `openai` provider issues an api.openai.com token that `chatgpt.com/backend-api/wham/usage` rejects (401), so only the `openai-codex` credential can report Codex usage.
