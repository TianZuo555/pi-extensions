# pi-compact

Fork of [`@narumitw/pi-codex-compact`](https://github.com/narumiruna/pi-extensions) (MIT)
that runs Codex remote compaction on a **configurable model**, independently of the session model.

Only `openai-codex` sessions create remote checkpoints. Other providers use Pi's native
compaction **unless an existing opaque checkpoint would be lost**.

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
  "compactionModel": "openai-codex/gpt-5.6-luna",
  "requestTimeoutMs": 300000,
  "maxRetries": 2,
  "replacementTokenBudget": 64000,
  "notifyOnFallback": true
}
```

- **`enabled`** controls creation of new remote checkpoints, not replay. Existing checkpoints
  continue to replay while the extension is loaded, even when this is `false`.
- **`protocol`** should be `auto` or `remote-v2` for Codex. The Codex `/responses/compact`
  endpoint returned HTTP 404 in live tests. Selecting `responses-compact` is rejected locally:
  without an opaque checkpoint Pi uses native compaction; with one, compaction is cancelled.
- **`compactionModel`** is `provider/modelId`. It must use the same provider, Responses API,
  and endpoint as the session model; otherwise the session model is used with a warning.
  Set it to `""` to always compact on the session model.
- **`requestTimeoutMs`** bounds the entire remote request, including retries and SSE body
  reading, not just the wait for HTTP response headers.
- **`maxRetries`** bounds provider retries within that deadline. Transient failures can be
  retried on later compaction attempts; definitive missing-route errors disable that route
  until session restart or reload.
- **`replacementTokenBudget`** limits retained user text using a character-based estimate,
  not exact tokenization. Opaque content and images also have separate byte limits.
- **`notifyOnFallback`** controls ordinary native-fallback warnings. Warnings about cancelling
  compaction to preserve an existing checkpoint are always shown when a UI is available.

Custom `/compact` instructions are appended to the remote request's system instructions for
that compaction only. They do not change future session instructions. A custom focus can change
the prompt-cache prefix.

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
to malformed checkpoint details bearing this extension's checkpoint kind.

After cancellation, restore a compatible model, enable remote compaction, or correct the failing
route and `/reload` before retrying `/compact`. An already-full context may require this recovery
before the next model turn. Original session entries remain available; no automatic conversion
of opaque history into a portable text summary is attempted. Unloading the extension entirely
removes these replay and failure-safety hooks.

Without an existing opaque checkpoint, remote failures still fall back to Pi's native compaction.

## Caching and retained history

Compaction requests carry the session ID as `prompt_cache_key` and the session's thinking level.
Cache is per-model: cross-model compaction cannot reuse the session model's cache, but repeated
compactions can reuse the compaction model's own cache.

The checkpoint represents the entire remote input, including recent messages. Replay removes
Pi's fingerprint-matched retained tail before injecting the replacement history. Some user text
is retained explicitly, while recently kept user text is omitted from those extra plaintext copies.
Live recall tests verified recent user values remained available through the opaque checkpoint,
including after two consecutive compactions and a disk resume. This does not guarantee lossless
summarization for arbitrary conversations.

## Tests

```bash
pnpm --filter @tian.zuo/pi-compact test
pnpm --filter @tian.zuo/pi-compact run check
```

Regression tests cover complete checkpoint projection and request rewriting, cross-model/backend
compatibility, cancellation instead of lossy fallback, disabled replay, transient recovery,
custom instructions, and a stalled SSE body using the real Codex serializer with a fake transport.
