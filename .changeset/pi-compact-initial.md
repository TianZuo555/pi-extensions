---
"@tian.zuo/pi-compact": minor
---

Add pi-compact, a fork of @narumitw/pi-codex-compact that decouples the remote compaction model from the session model. The Codex backend does not bind opaque compaction items to the producing model — verified live: a checkpoint produced by gpt-5.6-luna replays correctly on gpt-5.6-sol, gpt-5.6-terra, and gpt-6-astra, and astra-produced items replay on luna — so compaction runs at a cheaper model's input price (~50x cheaper for astra sessions on luna) with identical replay behavior.

Adds a `compactionModel` setting ("provider/modelId", default `openai-codex/gpt-5.6-luna`, empty restores session-model behavior) in `~/.pi/agent/pi-compact.json`, plus a text `/remote-compact` command (`status`, `now`, `on|off`, `model <ref>`) replacing the upstream TUI menu. Checkpoints keep recording the session model so the existing replay gate is unchanged, and remote compaction is skipped when the session model cannot replay opaque items.

Compaction requests now forward the session id as `prompt_cache_key` and match the session's thinking level — upstream sent `cacheRetention: "none"` and no `reasoning` field, which made every compaction call a guaranteed cache miss. Measured live: a 25.7K-token compaction on sol dropped from $0.136 (0 cached) to $0.021 (25.4K cached-read). Cross-model compaction (luna for an astra/sol session) can't reuse the session's cache but benefits on repeated compactions via luna's own.

Retained user history no longer duplicates Pi's kept suffix: `buildReplacementHistory` accepts an `excludeTexts` set built from the kept user messages, so post-compaction turns stop replaying those messages twice.

Remote compaction is hard-gated to the `openai-codex` provider — other Responses-API providers (verified: github-copilot `/responses/compact` returns 404) go straight to Pi native. Per-session route breaker on top: a codex route is blacklisted after a definitive failure (4xx/"not found") or two transient ones, avoiding repeated doomed full-payload attempts.

Marker rewrite in `before_provider_request` now scans `payload.input` once instead of twice.
