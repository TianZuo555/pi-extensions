# @tian.zuo/pi-devin-acp

## 0.1.1

### Patch Changes

- [#57](https://github.com/TianZuo555/pi-extensions/pull/57) [`b632c43`](https://github.com/TianZuo555/pi-extensions/commit/b632c4349333b8bdb50db739490c8f13b5de6fe2) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix cancellation and session replacement races during ACP startup, isolate restored session state, and preserve the accepted mode after invalid or rejected changes. Use unique replay tool IDs across Pi provider calls, honor thinking off, account for turn usage only once, and handle tools whose initial notification is already terminal. Queue task-stop requests as steering messages while Pi is running.

- [#58](https://github.com/TianZuo555/pi-extensions/pull/58) [`b3b64c3`](https://github.com/TianZuo555/pi-extensions/commit/b3b64c3e35fff8226dd5dd8c4c73c1f0cf074536) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Stop dropping user messages that arrive while devin is working. Superseding a live ACP turn (`session/cancel` followed by a new `session/prompt` on the same session — a steering/follow-up message, `/devin tasks` shell stop, or any prompt typed mid-turn) sent the new prompt before devin acknowledged the cancel, so devin cancelled the *new* prompt instead: the user saw an empty "Operation aborted" turn and the request never reached the agent. The runtime now waits (bounded, ~3 s) for the cancelled prompt to settle before reusing the session; live devin acks in 5–10 ms. Also: deleting a devin session that is not the bound one no longer appends a session-state reset marker (the branch binding survives), recorded replay results are capped at 16k characters and evicted oldest-first so pi's session file cannot grow with full devin tool output, tool-card bodies and live-op labels strip terminal escapes/control characters, and the incomplete-tool sweep defers a `stop` result instead of an unmapped one. Tool cards are written back into the persisted assistant message at their terminal view (pi stores the content array, not the `toolcall_end` payload), and `before_provider_request` now fires for devin turns with the ACP prompt request so extensions can inspect or replace the outgoing content blocks.

- [#55](https://github.com/TianZuo555/pi-extensions/pull/55) [`12c1b31`](https://github.com/TianZuo555/pi-extensions/commit/12c1b31f0ebbc043d6ec8b3bc98e7ccf05ada44f) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Renamed the package from `@tian.zuo/pi-devin` to `@tian.zuo/pi-devin-acp` before its first npm publish — the directory, legacy stub (`extensions/pi-devin-acp.ts`), session-state entry key (`pi-devin-acp-session-state`), and state dir (`~/.pi/devin-acp/`) moved with it; existing `pi-devin-session-state` bindings are not migrated. Provider name (`devin`), models (`devin/*`), and commands (`/devin …`) are unchanged.

## 0.1.0

### Minor Changes

- [#51](https://github.com/TianZuo555/pi-extensions/pull/51) [`ce34163`](https://github.com/TianZuo555/pi-extensions/commit/ce34163fc5f2c45263a1934f19b52caa2ae58d2b) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Initial release: Devin ACP provider extension for pi.
  
  Registers `devin/*` models backed by `devin acp` (Agent Client Protocol over
  stdio), preserving Devin's native server-side agent loop. Includes model
  catalog discovery from `devin models list` with thinking-level resolution,
  per-branch session persistence via `session/load`, streamed text/thinking,
  display-only tool cards with result replay, permission prompts, Devin modes,
  `/devin` commands (status/reset/sessions/mode/models/login/doctor), and usage
  reporting.

### Patch Changes

- [#53](https://github.com/TianZuo555/pi-extensions/pull/53) [`6b1e70b`](https://github.com/TianZuo555/pi-extensions/commit/6b1e70bd5c6514b378793f2317a1e1a1a735ef40) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Keep the live ACP session on devin→devin model switches — the new model is applied via `session/set_config_option` instead of dropping the binding; only cross-provider transitions re-bootstrap. Devin's advertised slash commands and skills-as-commands are now reachable as `/devin-<name>` — input interception forwards `/<name> args` into the ACP session, so the pseudo-commands only exist while a devin model is selected and can safely shadow pi builtin names. Pi-side compaction is vetoed for devin models (`session_before_compact`): manual `/compact` is cancelled and forwarded to devin's own `/compact` command, while automatic (threshold/overflow) passes are simply skipped — devin manages context server-side. `/skill:<name>` under a devin model runs devin's same-named skill-command instead of expanding pi's skill, and `/devin-<sub>` aliases (`/devin-tasks`, `/devin-sessions`, …) run the pi-side `/devin` subcommands inline. Disposable summary sessions now sync the selected devin model. Background terminals: a devin command detached to a background shell (`_meta background/backgroundShellId`) that outlives its turn now replays as a neutral note with the shell id instead of a spurious failure card, and `shell_id` shows in tool-card summaries. In-flight devin operations now surface as live tasks: a status-bar widget shows `devin: N running — <title>` while any tool call is still in flight (including across turns), and `/devin tasks` lists them with elapsed time and shell ids — background shells can be killed by asking devin from the picker.
  
  Also fixes: a stale `devin acp` exit can no longer clobber a replacement client's session binding, duplicate permission option names are disambiguated in the select UI, cancelled turns no longer count toward the session turn counter, a thinking level below a family's effort floor (e.g. `devin/swe-2:low` where the lowest row is medium) now clamps to the lowest available row instead of resolving to the highest-effort variant, and usage mapping now reports fresh input as `inputTokens - cachedReadTokens` (devin's `inputTokens` is total-inclusive) so pi's per-turn "Cache miss" detector no longer double-counts cache reads and fires a spurious re-billing notice every turn.
