# OpenAI authentication and cache probe

These are live observations from synthetic requests through Pi 0.99.1's model registry and
real serializers, using the installed OAuth credentials without logging tokens or opaque
checkpoint contents. All probes used `gpt-6-luna`, zero retries, and bounded deadlines.
Provider policy and best-effort caching can change; these are not guarantees.

## Authentication

| Provider / credential | Operation | Observed result |
| --- | --- | --- |
| `openai-codex` / legacy OAuth | `/backend-api/codex/responses` with `compaction_trigger` | HTTP 200, opaque `compaction` item |
| `openai` / Sign in with ChatGPT | `/v1/responses/compact` | HTTP 401, `hardened_oauth_rule_missing` |
| `openai` / Sign in with ChatGPT | `/v1/responses` with `compaction_trigger` | HTTP 400, `subscription_sharing_unsupported_capability` |
| `openai` / Sign in with ChatGPT | Normal `/v1/responses` text summarization | HTTP 200, readable summary |

The extension therefore keeps remote compaction restricted to legacy Codex. The new OAuth
path uses Pi's `compact()` helper and registry `streamSimple()` on Luna 6. It preserves Pi's
preparation, split-turn summaries, prior text summary, file lists, usage, and cancellation.
Switching an opaque Codex checkpoint to the new provider cancels compaction by default.

## Cache experiment

Use a fresh session ID and unique, fixed system prefix; run the original conversation twice,
summarize its history with `requestTextCompaction()`, then send the summary under the same
system prefix twice. Finally resend the original conversation. These were synthetic inventory
records with a sentinel value; the summary preserved that value.

The table shows total **input** tokens (`usage.input + usage.cacheRead`) and cached input
(`usage.cacheRead`). All calls used the same model, to isolate prefix effects rather than
cross-model cache isolation.

### Long unchanged system prefix

| Request | Input tokens | Cached tokens |
| --- | ---: | ---: |
| Original conversation, cold | 7,554 | 0 |
| Original conversation, repeated | 7,554 | 6,912 |
| Pi text-summary request | 2,699 | 0 |
| Post-compaction conversation, first | 5,297 | 4,864 |
| Post-compaction conversation, repeated | 5,297 | 4,864 |
| Original conversation again after summary | 7,554 | 6,912 |

The changed history did not prevent reuse of the unchanged system prefix. The original
conversation still hit its old cache after summarization, so summarization did not globally
invalidate it.

### Shorter compacted request

| Request | Input tokens | Cached tokens |
| --- | ---: | ---: |
| Original conversation, cold | 4,157 | 0 |
| Original conversation, repeated | 4,157 | 3,840 |
| Pi text-summary request | 2,699 | 0 |
| Post-compaction conversation, first | 1,893 | 0 |
| Post-compaction conversation, repeated | 1,893 | 0 |
| Original conversation again after summary | 4,157 | 3,840 |

Do not assume every small request will be cached. These observations do not establish a
precise minimum cache threshold.

## Practical consequences

- The summary request serializes history into Pi's standalone summarization prompt and uses
  `cacheRetention: "none"`, with no `prompt_cache_key`. It did not reuse the conversation
  cache in either probe.
- Compaction changes the history prefix, so its previous cache cannot be assumed reusable.
  Unchanged system/tool prefixes may still hit; later turns can establish a new history cache.
- A Luna compaction request cannot share an expensive session model's cache anyway:
  caching is per model.
- Text compaction is portable and readable, but not a lossless replacement for opaque
  checkpoint history.
