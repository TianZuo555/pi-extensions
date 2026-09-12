# @tian.zuo/pi-devin

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
