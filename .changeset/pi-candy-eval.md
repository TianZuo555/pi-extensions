---
"@tian.zuo/pi-candy-eval": minor
---

Add pi-candy-eval: probe Codex accounts with a fixed candy reasoning puzzle through the magpie gateway. `/candy` probes every switched-on account, `/candy <email>` one of them, `/candy history` shows the last runs with their reasoning-token median, and the `candy_eval` tool does the same for the model. Each run issues a ten-minute gateway key held to one account and appends the answer, verdict, reasoning tokens and latency to `~/.pi/candy-eval/runs.jsonl`; 21 is the pass, 29 is the answer for the blind version of the puzzle.
