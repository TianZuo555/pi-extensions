---
"@tian.zuo/pi-beautify-style": minor
---

Show the current reasoning step instead of `Thinking...` when the reasoning has no heading (DeepSeek, GLM, Kimi, and other `reasoning_content` models): `Step 3 · Check the CI config · 6s`. A step comes from an intent sentence (`Let me …`, `I'll …`, `让我…`), a lead such as `Plan:` or `Decision:`, or a rethink (`Actually, let me …`). Each label stays at least 800 ms, so fast thoughts do not flicker. The finished card keeps the last step and the count: `Check the CI config · Thought for 8s · 3 steps`.
