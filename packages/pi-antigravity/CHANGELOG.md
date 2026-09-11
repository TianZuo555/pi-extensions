# @tian.zuo/pi-antigravity

## 0.11.0

### Minor Changes

- [#48](https://github.com/TianZuo555/pi-extensions/pull/48) [`1fa16bd`](https://github.com/TianZuo555/pi-extensions/commit/1fa16bd7fc7a33b5445dd165e0067bc94fee84f0) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Add `/agy-subagents`: a zero-token roster of agy subagent activity folded from the stream (invoke_subagent/run_subagent/define_subagent/browser_subagent spawns, send_message counts, manage_subagents kills), reset together with the conversation. agy has no read-only subcommand for live subagent state — `/subagents` in print mode burns a model turn — so the extension tracks the tool steps itself.
  
  Flatten the `/agy` subcommands into top-level commands: `/agy reset|models|agents|doctor` are now `/agy-reset`, `/agy-models`, `/agy-agents`, `/agy-doctor` (consistent with `/agy-tasks`, `/agy-artifacts`, `/agy-usage`). Bare `/agy` still shows status and points at the new names when given arguments.

### Patch Changes

- [#54](https://github.com/TianZuo555/pi-extensions/pull/54) [`1b42825`](https://github.com/TianZuo555/pi-extensions/commit/1b42825c359d728ecf3e4cdff3e3a6339318ecb9) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Move the per-tool-start orphan snapshot off the event loop: a new tool step now queues a coalesced async `ps` scan instead of running `spawnSync("ps")` inside the driver's line handler, so tool bursts no longer stall the TUI. A turn that dies while a scan is still queued settles only after the snapshot lands, preserving the "recorded before agy exits" guarantee.
  
  Task scans no longer read whole task logs on every poll — `listAgyTasks` reads only an 8 KiB head for the description line (widget rescans every 2 s, the dashboard every 1 s, and a long-lived task's log grows without bound), and a log deleted mid-scan no longer fails the whole listing.
  
  Subagent steps are no longer invisible: agy emits `invoke_subagent`/`send_message`/`manage_subagents` as `step_type: "subagent"` with the payload under `subagent_info` (not `tool_info`), and the reducer used to drop them entirely — no tool card, and `/agy-subagents` always reported nothing. They now fold into normal tool activities with normalized args, so spawns render as cards and the roster finally populates.
  
  Stale-session safety: every session-bound ctx getter throws once pi invalidates the extension runner, and `agent_settled`/`model_select` can still be dispatched around a session swap or shutdown. Handlers now probe ctx before touching it, and `persistConversationState` reads its fields before awaiting — the `extension_error` noise seen when a turn settles during `/new` or quit is gone.
  
  Smaller fixes: `stopAgyTask` no longer double-counts a holder already reached by its process-group signal; `/agy` reports the scheduling context window (1m) instead of a hardcoded `185k`; `/agy` with arguments now lists every `agy-*` command; navigating the session tree clears the subagent roster like `/agy-reset` does; the wrapper-tool activation sync tolerates unavailable tool APIs like the other tool callers; one-shot `agy` spawns and the `/usage` exec path now pass `windowsHide`; and the duplicated `agyBrainDir()` lives in `lib/agy-paths.ts`.

- [#50](https://github.com/TianZuo555/pi-extensions/pull/50) [`615bed4`](https://github.com/TianZuo555/pi-extensions/commit/615bed46b9891057c55608b3acb32290ee580f6a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Slim the agy instruction relay down to pi's documentation block only, rebuilt from the installed pi package — pi-tool boilerplate, the duplicated skill catalog, workspace `AGENTS.md`/rules files agy discovers natively, and user-authored pi customizations no longer ride every fresh conversation. Summarization requests keep their own caller instructions instead of being overridden by the relay.
  
  Restrict bridged skills to pi-private roots (`~/.pi/agent/skills`, `<project>/.pi/skills`, pi-package installs): shared `.agents` skill dirs are agy's own discovery domain or belong to other agents. When the pi-tool bridge is off or fails to register, the skill catalog is no longer injected into the prompt — the user gets a one-time warning that pi-private skills are unavailable.
  
  Snapshot task-shaped agy children on every genuinely new `tool_start` step (repeated ACTIVE updates for the same step still skip the synchronous `ps` scan), so a worker spawned during a tool burst is recorded before an unexpected agy exit can orphan it.

- [#50](https://github.com/TianZuo555/pi-extensions/pull/50) [`615bed4`](https://github.com/TianZuo555/pi-extensions/commit/615bed46b9891057c55608b3acb32290ee580f6a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - End turns agy parks on background work instead of stalling until the deadline, and recover the answer agy withholds. agy 1.2.0 holds a turn's `result` event — including the finished answer — until every background task exits (bounded by the ~25-day `--print-timeout`), and terminating the process discards that answer entirely. The stall watchdog now reads the transcript agy keeps appending off-stream: when the newest step is a finished response that postdates the still-ACTIVE tool step and carries no `tool_calls` (a DONE response requesting tools is mid-turn planning, not an answer), the turn gets a short grace — then ends normally with the transcript's answer text restored, the tool step replaying as an incomplete card pointing at `/agy-tasks`, and the agy process recycled like any backgrounded turn.
  
  Shutdown now also reaps detached task processes it missed before: every process-group-leading child of pi's tracked agy processes is signalled by direct ancestry while agy is still alive, every recorded orphan across all conversations this pi ran is included (a `/agy reset` or conversation switch no longer hides them), and any group still holding members after the SIGTERM grace is escalated to SIGKILL — closing pi no longer leaves `sleep`/dev-server task groups running. Orphan groups stay verifiable after their leader exits because member identities are captured while the leader is still provable, so even children a build or watcher spawns late are reached; every sweep re-verifies a record's start-time identity before signalling (a reused pid is never touched), group-addressed kills have no bare-pid fallback, and a transient `ps` failure prunes nothing — records retry on the next scan instead of losing ownership of live processes.

- [#50](https://github.com/TianZuo555/pi-extensions/pull/50) [`615bed4`](https://github.com/TianZuo555/pi-extensions/commit/615bed46b9891057c55608b3acb32290ee580f6a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Keep the persistent CLI's print wait above Pi's own turn deadline. When agy's default five-minute print wait expires mid-turn it reports `SUCCESS` with an empty response while the agent keeps working (`[agy] print timeout after 15s with turn in progress; returning partial output`), prematurely ending the Pi turn and dropping the final answer. Preserve distinct terminal answers instead of discarding them when they differ from streamed commentary, ignoring trailing-whitespace drift between agy's deltas and its result text so an already-rendered answer is never repeated.

- [#50](https://github.com/TianZuo555/pi-extensions/pull/50) [`615bed4`](https://github.com/TianZuo555/pi-extensions/commit/615bed46b9891057c55608b3acb32290ee580f6a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Stop relaying Pi's builtin tool inventory to agy. The instruction snapshot is written for a model holding Pi's tools, but agy runs its own native tool set and reaches Pi only through bridged MCP tools — `selectBridgedTools` never exposes a Pi builtin — so the `Available tools:` block described tools agy cannot call and spent prompt tokens on every conversation. Only Pi's own validated top-level block is dropped — it must precede any project context, contain `- name: description` bullets, and end with Pi's trailing caveat — so an `Available tools:` line inside project instructions (a deployment section listing terraform/kubectl, say) relays untouched along with all other guidance. Incomplete `schedule` replays also no longer point at `/agy-tasks`: agy runs schedule timers in-process, so they hold no task pid and the dashboard always renders them as done.

- [#50](https://github.com/TianZuo555/pi-extensions/pull/50) [`615bed4`](https://github.com/TianZuo555/pi-extensions/commit/615bed46b9891057c55608b3acb32290ee580f6a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Protect live foreground commands from `/agy-tasks stop all` by verifying the recorded agy parent's identity and requiring it to have exited; the sweep also runs with no live conversation, so a `/agy reset` no longer leaves recorded orphans unreachable until shutdown. Keep whole-Pi shutdown able to reap attached work, and escalate the actual signalled process groups rather than treating log-holder PIDs as PGIDs.
  
  Poll transcript completion during tool-liveness grace periods without consuming additional grace budgets, and skip parked waits that would cross the turn deadline. Expand transcript tails with an 8 MiB cap so large JSONL final answers remain recoverable.
  
  Track response-step text across tool handoffs so a final-only result completes a partially streamed answer instead of repeating its prefix.

- [#50](https://github.com/TianZuo555/pi-extensions/pull/50) [`615bed4`](https://github.com/TianZuo555/pi-extensions/commit/615bed46b9891057c55608b3acb32290ee580f6a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Stop killing long quiet tool steps as stalls. agy emits no stdout while a tool is ACTIVE, so a slow foreground command (a cold `cargo build`) was indistinguishable from a wedged process and died once `AGY_TOOL_STALL_TIMEOUT_MS` elapsed. The watchdog now asks for positive evidence before killing: when the tool budget expires it checks for a live process-group-leading child of the agy process and extends the budget while that evidence holds, bounded by a grace ceiling so tools that spawn nothing (`schedule`, `search_web`) still time out. Turns stalled between steps, where no tool is running, fail immediately as before without paying for the scan. Probes are epoch-fenced: if stream activity rearms the watchdog while a probe is in flight, that probe's verdict is discarded instead of killing a turn that has since resumed.

- [#50](https://github.com/TianZuo555/pi-extensions/pull/50) [`615bed4`](https://github.com/TianZuo555/pi-extensions/commit/615bed46b9891057c55608b3acb32290ee580f6a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Detect running agy background tasks via process ancestry. agy 1.2.0 pipes task output through the agent process, so no task ever holds its `task-N.log` open and `/agy-tasks` listed live tasks as done. Scans now also match process-group-leading children of the live agy processes pi spawned. Ownership is never guessed, because stopping a task signals its whole process group and a wrong guess would kill a sibling task's work — or the user's still-running foreground `run_command`, which shares the exact same shape and can even share the command line. Only a proven log holder is stoppable per-task; orphans recorded while their agy parent was still alive (`recordAgyTaskOrphans`) are re-verified by start-time identity on every scan so a stale record can never name a reused pid, but they are advisory too — conversation-level provenance cannot bind a process to one task. Everything else — ancestry+birth matches, cwd+time orphans from the conversation-shared agy config directory — is `unclear`: shown with pids but never signalled, and `x`/`stop` explains when a task has no provably-owned process instead of silently doing nothing. `/agy-tasks stop all` additionally reaps this conversation's identity-verified orphan groups.

- [#50](https://github.com/TianZuo555/pi-extensions/pull/50) [`615bed4`](https://github.com/TianZuo555/pi-extensions/commit/615bed46b9891057c55608b3acb32290ee580f6a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Never register Antigravity models from an expired on-disk model cache at startup. The cache was previously used unconditionally until an agy model was selected, so a stale cache written by an older extension version could pin a missing/outdated model list (e.g. hiding newly released models). Startup now registers from the fallback catalog baked into the installed build and heals to the live `agy models` list in the background, honoring the existing live (24h) and fallback (5min) TTLs.

## 0.10.3

### Patch Changes

- [#44](https://github.com/TianZuo555/pi-extensions/pull/44) [`a5f357f`](https://github.com/TianZuo555/pi-extensions/commit/a5f357f3fce149983405b830f7bdeb2228f93bdf) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Preserve terminal results across incomplete-tool replay so Pi does not automatically resubmit the original command after a background-task timeout. Track emitted text across replay messages to avoid repeating the terminal response, emitting only a missing suffix and preserving streamed text on divergence.
  
  Defensively recycle persistent agy processes when terminal results leave tools ACTIVE, including failed results, while retaining the conversation ID for subsequent user turns. Quarantine the driver immediately, allow its process group 500 ms to handle SIGTERM, then force cleanup of surviving processes before releasing queued turns. Keep cleanup tracked during shutdown. Unfinished commands may be cancelled; bridge handoff and incomplete-tool messages now explain this and recommend refreshing /agy-tasks before retrying, without promising that one-shot tasks stopped.
  
  Improve empty-stderr diagnostics with model/conversation context and recovery options without assuming a cause.

## 0.10.2

### Patch Changes

- [#40](https://github.com/TianZuo555/pi-extensions/pull/40) [`5cdfd49`](https://github.com/TianZuo555/pi-extensions/commit/5cdfd4987b9724698587309431adfb3a3a7e2b9f) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Restore Pi history on the first Antigravity handoff while preserving explicit reset behavior, relay and synchronize Pi instructions through agy's text interface without dropping pending instruction or skill updates on stall retries, prevent cancelled startup from submitting prompts, and track overlapping native tool steps correctly. Enforce a single logical-turn deadline across startup, retries, and backoff, and clarify that native agy operations bypass Pi's permission hooks.

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
