---
"@tian.zuo/pi-antigravity": minor
---

Render agy's collapsed reasoning line as a native Pi thinking block: `Thought for 3s, 289 tokens` appears above each answer (tokens and step duration from the response step's usage). agy only reports the token count on the response step's DONE event, so the thinking slot is reserved before the text run and filled on completion — assistant-message content indices stay append-only, keeping delta-only consumers (`pi --mode json`, proxy streams, extensions reading `assistantMessageEvent`) in sync. Thought text itself is never exposed by agy's print-mode stream-json protocol, so only the summary line is shown.

Also report agy `thinking_tokens` as Pi reasoning usage, and fail turns closed on any result status agy does not explicitly report as successful — `SUCCESS` (agy >= 1.1.22) and `OK` complete the turn, while `ERROR`, `FAILURE`, `CANCELLED`, `TIMEOUT`, and unrecognized statuses now surface as errors instead of rendering as normal answers.

Fixed a related streaming bug: when agy's authoritative final response extended the streamed deltas, the text block was rewritten without emitting a delta, so delta-only consumers kept the truncated text. The missing tail is now sent as a real `text_delta`.
