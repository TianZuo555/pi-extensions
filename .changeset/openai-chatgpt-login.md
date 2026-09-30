---
"@tian.zuo/pi-web-search": patch
---

Detect pi's `/login` → "Sign in with ChatGPT" credential on the `openai` provider so OpenAI search works without `OPENAI_API_KEY`. The OAuth entry stores `access` (not `key`) under `openai` in `~/.pi/agent/auth.json`; expired tokens are skipped and the auth dialog now reports which OpenAI login is fresh or expired. Also fix token routing: both ChatGPT OAuth tokens embed the `https://api.openai.com/auth` JWT claim, so Codex-backend routing now keys off `chatgpt_account_id` — the direct OpenAI token correctly uses `api.openai.com/v1/responses` instead of being misrouted to `chatgpt.com`.
