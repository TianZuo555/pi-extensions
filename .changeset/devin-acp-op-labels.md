---
"@tian.zuo/pi-devin-acp": minor
---

Add `/devin-usage` (also `/devin usage`): a report of the usage devin reports over ACP — context-window occupancy bar, cumulative session tokens/cost (`usage_update` counters, `cost`, `totalCreditCost`/`totalAcuCost`), and last-turn stats — rendered in /usage's padded-label style with the server's own `responseDimensions` grouping, so new usage dimensions surface without a client update. The runtime snapshot now carries the merged `usage` object, and `cachedWriteTokens`, `creditCost`, `acuCost`, and `responseDimensions` are captured from `usage_update`/`agent_stopped` payloads.

Live-op labels no longer fall back to "(untitled op)" when devin omits the tool-call title — the status widget and `/devin-tasks` views now synthesize a label from the call summary (e.g. `execute · sleep 60`, from kind/locations/rawInput) or the devin tool name, so running operations are identifiable at a glance.
