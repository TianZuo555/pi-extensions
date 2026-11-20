---
"@tian.zuo/pi-smart-gpt": minor
---

Add pi-smart-gpt: test whether a Codex account got dumber with a fixed reasoning puzzle through the magpie gateway. `/smart` tests every switched-on account, `/smart <email>` one of them, `/smart history` shows the last runs with their reasoning-token median, and the `smart_gpt` tool does the same for the model. Each run issues a ten-minute gateway key held to one account and appends the answer, verdict, reasoning tokens and latency to `~/.pi/smart-gpt/runs.jsonl`; 21 is the pass, 29 is the answer for the blind version of the puzzle.
