# @tian.zuo/pi-antigravity

## 0.10.1

### Patch Changes

- [#36](https://github.com/TianZuo555/pi-extensions/pull/36) [`c1184d7`](https://github.com/TianZuo555/pi-extensions/commit/c1184d76f34f5def05b808cd552cf4ad5d94cc1a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix print-mode string prompts and preserve consecutive user messages so extension-added context no longer replaces the caller's request. Use the same request boundary when restoring history and retain string-form historical messages.

## 0.10.0

### Minor Changes

- [#22](https://github.com/TianZuo555/pi-extensions/pull/22) [`be0df7c`](https://github.com/TianZuo555/pi-extensions/commit/be0df7cc89eed7b44ec4906509070391840e0177) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Add `gemini-3.8-flash` (Gemini 3.8 Flash, low/medium/high efforts) to the fallback model catalog from the agy 1.1.25 `agy models` snapshot, with $0.75/$3.75 per-million-token reference pricing. `gemini-3.5-flash`, no longer served by current agy, is dropped from the fallback snapshot; live discovery continues to surface whatever the installed agy reports.

## 0.9.0

### Minor Changes

- [#17](https://github.com/TianZuo555/pi-extensions/pull/17) [`4f82756`](https://github.com/TianZuo555/pi-extensions/commit/4f8275685d3b571216b83c32b7e663fc29eaae9d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Require agy 1.1.22+, select the newest compatible installed stable binary with automatic cache invalidation, reuse a persistent stream-json driver across ordinary turns, report spawn/recycle counters and causes, recycle safely when model/profile/bridge configuration changes, add binary and model-effort diagnostics, expose custom agent and plan-mode configuration, enrich conversation status, and add safe direct markdown artifact previews.

### Patch Changes

- [#14](https://github.com/TianZuo555/pi-extensions/pull/14) [`f1ae49c`](https://github.com/TianZuo555/pi-extensions/commit/f1ae49c22e01e58b7b729f11e1faef75a27d0ca7) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Let agy own native context compaction through a 1M Pi scheduling window, persist safe same-session conversation resumes, render detected agy compaction boundaries, isolate Pi fallback summaries, report per-response usage, and show at most one substantive thought row per turn.

## 0.8.0

### Minor Changes

- [#2](https://github.com/TianZuo555/pi-extensions/pull/2) [`baaa3f5`](https://github.com/TianZuo555/pi-extensions/commit/baaa3f55eee64623fe44501583996639c577d35d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Add `/agy-usage` to inspect Antigravity weekly and 5-hour model quotas in the same Refresh/Close menu as `/usage`.

- [#11](https://github.com/TianZuo555/pi-extensions/pull/11) [`548f026`](https://github.com/TianZuo555/pi-extensions/commit/548f02610a1571d513c5d29b816096042ff2bf18) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Bridge global pi skills as one `pi__p<pid>__activate_skill` tool whose JSON-schema enum is the catalog and whose description carries each skill's one-liner, preserving pi's progressive disclosure. Bridge mode no longer appends `## pi Agent Skills` to the user prompt — tools/list is rebuilt on every agy spawn, including after compaction. When the bridge is disabled or fails to register with agy, the direct-mode path catalog is used as a fallback so skills are never silently invisible.

- [#11](https://github.com/TianZuo555/pi-extensions/pull/11) [`548f026`](https://github.com/TianZuo555/pi-extensions/commit/548f02610a1571d513c5d29b816096042ff2bf18) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Register the pi-tool bridge only while an Antigravity model is selected: `pi-bridge-<pid>` is created when an agy model is first selected (including session start on one) and deregistered — with its manifest cache evicted — when switching to any other model or shutting down. Sessions that never use Antigravity models no longer run a bridge server or touch agy at all.

- [#11](https://github.com/TianZuo555/pi-extensions/pull/11) [`548f026`](https://github.com/TianZuo555/pi-extensions/commit/548f02610a1571d513c5d29b816096042ff2bf18) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Render agy's collapsed reasoning line as a native Pi thinking block: `Thought for 3s, 289 tokens` appears above each answer (tokens and step duration from the response step's usage). agy only reports the token count on the response step's DONE event, so the thinking slot is reserved before the text run and filled on completion — assistant-message content indices stay append-only, keeping delta-only consumers (`pi --mode json`, proxy streams, extensions reading `assistantMessageEvent`) in sync. Thought text itself is never exposed by agy's print-mode stream-json protocol, so only the summary line is shown.
  
  Also report agy `thinking_tokens` as Pi reasoning usage, and fail turns closed on any result status agy does not explicitly report as successful — `SUCCESS` (agy >= 1.1.22) and `OK` complete the turn, while `ERROR`, `FAILURE`, `CANCELLED`, `TIMEOUT`, and unrecognized statuses now surface as errors instead of rendering as normal answers.
  
  Fixed a related streaming bug: when agy's authoritative final response extended the streamed deltas, the text block was rewritten without emitting a delta, so delta-only consumers kept the truncated text. The missing tail is now sent as a real `text_delta`.

### Patch Changes

- [#7](https://github.com/TianZuo555/pi-extensions/pull/7) [`c160eaa`](https://github.com/TianZuo555/pi-extensions/commit/c160eaac7ba17055d8324f3e609e036d189bf66a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Shorten home-directory paths in tool cards via `os.homedir()` instead of `$HOME`, so `~/...` also renders on Windows, where that variable is unset.

- [#11](https://github.com/TianZuo555/pi-extensions/pull/11) [`548f026`](https://github.com/TianZuo555/pi-extensions/commit/548f02610a1571d513c5d29b816096042ff2bf18) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Reap agy subprocess trees with cross-platform tree cleanup (process group on POSIX, taskkill on Windows) instead of signaling only the direct child, make death hooks reload-safe, and sweep every tracked group on exit, SIGHUP, and at the end of session shutdown without terminating the host process so Pi's async graceful shutdown is not preempted. A wedged `agy` no longer leaves orphaned processes behind when pi closes mid-call, and shutdown-path `agy mcp remove` now uses a 5-second budget so closing pi cannot stall on it.

- [#11](https://github.com/TianZuo555/pi-extensions/pull/11) [`548f026`](https://github.com/TianZuo555/pi-extensions/commit/548f02610a1571d513c5d29b816096042ff2bf18) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Detect and recover from stalled agy streams. A watchdog kills the turn when stdout/stderr produce no bytes for `AGY_STALL_TIMEOUT_MS` (default 120s; 300s while a tool step is ACTIVE, `0` disables), then resumes the conversation — or re-attempts the original prompt if stalled pre-init — with at most two retries instead of hanging until the 600s turn timeout. Once a terminal result is parsed, the stall watchdog is disarmed and resolves immediately without waiting for stdio close. Retries render as a collapsed "agy stream stalled … restarting the turn" thinking line, and turn budgets are now tunable via `AGY_TURN_TIMEOUT_MS` / `AGY_TOOL_STALL_TIMEOUT_MS` / `AGY_STALL_RETRY_BACKOFF_MS`.

- [#11](https://github.com/TianZuo555/pi-extensions/pull/11) [`548f026`](https://github.com/TianZuo555/pi-extensions/commit/548f02610a1571d513c5d29b816096042ff2bf18) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Evict agy's on-disk MCP tool-manifest cache (`~/.gemini/antigravity-cli/mcp/pi-bridge-*/`) when bridge registrations are pruned at startup and on session shutdown, so dead sessions no longer leak a manifest directory per session. Bridge registration state is now tracked separately from the HTTP listener, so failed agy MCP registration leaves direct skills visible and permits registration to retry on subsequent registration attempts (such as session resume or model re-selection).

- [#8](https://github.com/TianZuo555/pi-extensions/pull/8) [`fb3955d`](https://github.com/TianZuo555/pi-extensions/commit/fb3955db85c5c6bd4c880b5ab73baedaca9fd540) Thanks [@thimpeng](https://github.com/thimpeng)! - Omit `agy --effort` when Pi does not set a reasoning level so models that reject the flag remain usable.

## 0.7.3

- Changelog tracking was introduced after this release.
