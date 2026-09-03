---
"@tian.zuo/pi-web-search": patch
---

Attribute answer-only OpenAI searches to their internal source: when the Responses API answers from an internal tool (e.g. `oai-weather`, `oai-finance`) with no web URLs, the tool result now says `answer via openai (internal source: oai-weather)` and notes the internal source for the model, instead of showing a bare `0 results`.
