# pi-compact

Fork of [`@narumitw/pi-codex-compact`](https://github.com/narumiruna/pi-extensions) (MIT)
that runs compaction on a **configurable model**, independently of the session model.
The default is **GPT-6 Luna** on the session's provider.

- Legacy `openai-codex` sessions use remote compaction with encrypted checkpoints.
- `openai` sessions authenticated with **Sign in with ChatGPT** use Pi's native **text
  summarizer on Luna**, with a warning once per session. This OAuth credential rejects
  `/responses/compact` (HTTP 401) and in-band `compaction_trigger` (HTTP 400).
- OpenAI API keys and other providers keep Pi's normal native compaction.

Routing follows the session provider, not merely which credentials are installed. To use
opaque checkpoints, select an `openai-codex` model; the extension never borrows credentials
across backends. An existing opaque checkpoint is protected on every fallback path.

## Usage

```bash
pi -e ./packages/pi-compact
```

Or add the package path to `packages` in `~/.pi/agent/settings.json`.
There are no additional commands: built-in `/compact [instructions]` and automatic compaction
are intercepted through `session_before_compact`.

Settings live in `~/.pi/agent/pi-compact.json` and reload at session startup or `/reload`:

```json
{
  "enabled": true,
  "protocol": "auto",
  "compactionModel": "gpt-6-luna",
  "requestTimeoutMs": 300000,
  "maxRetries": 2,
  "replacementTokenBudget": 64000,
  "notifyOnFallback": true,
  "allowLossyNativeFallback": false
}
```

- **`enabled`** controls extension compaction (remote or text), not replay. Existing checkpoints
  continue to replay while the extension is loaded, even when this is `false`.
- **`protocol`** should be `auto` or `remote-v2` for Codex. The Codex `/responses/compact`
  endpoint returned HTTP 404 in live tests. Selecting `responses-compact` is rejected locally:
  without an opaque checkpoint Pi uses native compaction; with one, compaction is cancelled.
  This setting does not affect the new OAuth text-summary path.
- **`compactionModel`** is a model ID (e.g. `gpt-6-luna`) on the session provider, or an explicit
  `provider/modelId`. It must use the same provider, Responses API, and endpoint as the session
  model; otherwise the session model is used with a warning. Set it to `""` to always compact
  on the session model. Existing explicit settings are not migrated: replace an older Luna
  reference with `gpt-6-luna` to use Luna 6 on either provider. If Luna 6 is missing from the
  catalogue, run `pi update --models`.
- **`requestTimeoutMs`** bounds the entire remote or text compaction, including retries and
  SSE body reading, not just the wait for HTTP response headers.
- **`maxRetries`** bounds provider retries within that deadline. Route failures are classified from
  the HTTP status the provider reported, with anchored message forms as a fallback; auth, timeout and
  rate-limit errors stay retryable. A route that fails three times in a row is abandoned until
  session restart or `/reload`. When falling back without a checkpoint, a disabled route adds one
  reminder (unless warnings are off), and repeated identical warnings are shown once per session.
- **`replacementTokenBudget`** limits retained user text using a character-based estimate,
  not exact tokenization. Opaque content and images also have separate byte limits.
- **`notifyOnFallback`** controls ordinary native-fallback warnings. Warnings about cancelling
  compaction to preserve an existing checkpoint are always shown when a UI is available.
- **`allowLossyNativeFallback`** is the escape hatch for the protection above. When `true`, a
  compaction that would be cancelled instead runs Pi's native summary and warns that the opaque
  history will no longer be readable. The default (`false`) keeps the checkpoint.

Custom `/compact` instructions are appended to the remote request's system instructions or
passed to Pi's text summarizer for that compaction only. They do not change future session
instructions. A custom focus can change the remote prompt-cache prefix.

The text path reuses Pi's summarizer, including previous summaries, split turns, retained recent
messages, file tracking, and usage accounting. It does not produce an opaque checkpoint and is
not lossless. Its warning is always shown when a UI is available, independently of
`notifyOnFallback`. Existing Codex checkpoints cannot be read by the text summarizer: switch
back to a compatible Codex model rather than discarding the history.

## Replay and failure safety

The Codex backend does not bind opaque `compaction` items to their producing model.
Live tests verified a Sol checkpoint replaying on Terra without changing its encrypted content.
The extension allows replay across models on the **same registered Codex provider, API and
endpoint**. If the original model is no longer in the catalogue, cross-model compatibility cannot
be checked, so only its original model ID is allowed. Endpoint changes to an existing model's
configuration cannot be detected retroactively because v2 checkpoints do not record endpoint URLs.

`details.modelId` records session-model provenance; it is not an exact-model replay lock.
Changing to an incompatible provider/API/endpoint leaves only the fallback explanation and raw
recent messages available. Keep this extension loaded and switch back to a compatible model for
full replay.

**An opaque checkpoint is not a native text summary.** If remote compaction fails, is disabled,
or cannot replay the existing checkpoint, the extension cancels that compaction and preserves
session state. It never hands the opaque placeholder to Pi's native summarizer. This also applies
to malformed checkpoint details bearing this extension's checkpoint kind. A final handler boundary
also returns cancellation if settings, model selection, UI notifications or status cleanup throw;
these exceptions must not escape to Pi's runner and implicitly authorize native compaction.

After cancellation, restore a compatible model, enable remote compaction, or correct the failing
route and `/reload` before retrying `/compact`. An already-full context may require this recovery
before the next model turn. Original session entries remain available; no automatic conversion
of opaque history into a portable text summary is attempted. Unloading the extension entirely
removes these replay and failure-safety hooks, and `allowLossyNativeFallback: true` opts into
replacing the checkpoint with Pi's native summary when a compaction would otherwise be cancelled.

A checkpoint only replays while it is the newest compaction entry in the branch: any later
compaction, including a native summary created while the extension was unloaded, supersedes it
and its older history stops being injected.

Without an existing opaque checkpoint, remote failures still fall back to Pi's native compaction.

## Caching and retained history

Remote compaction requests carry the session ID as `prompt_cache_key` and the session's thinking level.
Cache is per-model: cross-model compaction cannot reuse the session model's cache, but repeated
compactions can reuse the compaction model's own cache.

The checkpoint represents the entire remote input, including recent messages. Replay removes
Pi's fingerprint-matched retained tail before injecting the replacement history. Some user text
is retained explicitly, while recently kept user text is omitted from those extra plaintext copies.
Live recall tests verified recent user values remained available through the opaque checkpoint,
including after two consecutive compactions and a disk resume. This does not guarantee lossless
summarization for arbitrary conversations.

Text summarization uses Pi's standalone summary prompt with `cacheRetention: "none"`, rather
than the session transcript prefix. Do not expect the summary request to reuse the session
model's cached conversation; cross-model cache sharing is unavailable regardless. After text
compaction the summary replaces the older conversation, so that part of the request must warm
again. Unchanged system/tool prefixes can still hit cache, and later requests can cache the
new summary prefix. Text summarization does not globally clear the session model's cache.
See [the live authentication and cache probe](docs/auth-and-cache.md) for measured examples,
including a shorter compacted request that did not hit cache.

Turn-time marker injection requires exactly one matching marker. Missing or duplicate markers leave
the payload unchanged without an extension error; the model sees the fallback marker rather than
opaque history. This is a quiet fallback, not guaranteed replay. Remote recompaction remains strict:
an absent or ambiguous prior marker is an error and cannot produce a replacement checkpoint.

## Tests

```bash
pnpm --filter @tian.zuo/pi-compact test
pnpm --filter @tian.zuo/pi-compact run check
```

Regression tests cover complete checkpoint projection and request rewriting, cross-model/backend
compatibility, cancellation instead of lossy fallback, disabled replay, transient recovery,
custom instructions, and stalled SSE bodies using real Pi serializers with fake transports.
New OAuth coverage includes Luna 6 selection, the once-per-session warning, ordinary text
checkpoint replay, previous summaries, split turns, file tracking, cancellation and deadlines.
