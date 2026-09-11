# pi-compact

Fork of [`@narumitw/pi-codex-compact`](https://github.com/narumiruna/pi-extensions) (MIT) with one
change: the remote compaction call runs on a **configurable model** instead of the session model.

Only applies to sessions on the **`openai-codex` provider**. Every other provider goes
straight to Pi's native compaction — github-copilot's `/responses/compact` is a verified 404,
and opaque checkpoints can't cross backends anyway.

The Codex backend does not bind opaque `compaction` items to the producing model — verified
empirically: a checkpoint produced by `gpt-5.6-luna` replays correctly on `gpt-5.6-sol`,
`gpt-5.6-terra`, and `gpt-6-astra` (and `astra` items replay on `luna`). So the expensive session
model keeps working while compaction runs at a much cheaper model's input price
(~50x cheaper for astra → luna).

## Usage

```bash
pi -e ./packages/pi-compact
```

or add the package path to `packages` in `~/.pi/agent/settings.json`.

Settings live in `~/.pi/agent/pi-compact.json`:

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

`compactionModel` is `provider/modelId` — must be an `openai-codex/*` model (same backend as the
session), otherwise the session model is used. Set it to `""` to restore upstream behavior.

There are no commands: pi's built-in `/compact` (and automatic compaction) is intercepted via
`session_before_compact` — on `openai-codex` sessions it performs remote compaction through the
configured model; elsewhere it does nothing and Pi's native summary runs as usual.

## Differences from upstream

- `compactionModel` setting; no commands or TUI menu (drops the `@narumitw/pi-tui-kit`
  dependency) — built-in `/compact` is intercepted transparently on codex sessions.
- Checkpoint `details.modelId`/`api` record the **session** model (the replay gate is unchanged).
- Remote compaction is skipped entirely when the session model cannot replay a checkpoint
  (non-Responses API) — falls back to Pi native.
- Compaction requests carry the session id as `prompt_cache_key` and the session's thinking
  level — upstream sent `cacheRetention: "none"` and no `reasoning`, so every compaction was a
  guaranteed cache miss. Measured: 25.7K-token compaction on sol went from $0.136 to $0.021.
  Cache is per-model: cross-model compaction can't reuse the session's cache, but repeated
  compactions hit the compaction model's own cache.
- Retained user history no longer duplicates the messages Pi keeps verbatim after the cut point.
- Non-`openai-codex` providers are hard-gated to Pi native compaction; a codex route that fails
  is also blacklisted for the session after a definitive error (or two transient ones) instead of
  burning `maxRetries+1` doomed requests per compaction.
- Marker rewrite scans the request payload once per turn instead of twice.

See the upstream README for protocol details, limits, and caveats. The opaque-checkpoint format is
identical (`pi-codex-remote-compaction` v2), so checkpoints created by either package replay under
the other.
