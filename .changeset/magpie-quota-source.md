---
"@tian.zuo/pi-usage": minor
---

Read provider usage from `magpie quota --json` first when magpie is installed, falling back to pi's own credentials per provider. magpie discovers the machine's agent sign-ins itself (Codex's auth.json, Copilot's keychain item, vendor API keys), so `/usage` keeps reporting Codex, Copilot, Z.ai/GLM and DeepSeek even when pi's stored credential is a magpie gateway placeholder or missing. `PI_USAGE_MAGPIE_BIN` overrides binary discovery.
