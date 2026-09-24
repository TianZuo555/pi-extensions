# @tian.zuo/pi-devin-acp

## 0.5.0

### Minor Changes

- [#115](https://github.com/TianZuo555/pi-extensions/pull/115) [`2b5fbad`](https://github.com/TianZuo555/pi-extensions/commit/2b5fbaddba5f26a12aa4967f6276eb3b103c3573) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Show Devin's `todo_write` task list as a live checklist widget above the editor instead of synthetic thinking blocks in the transcript. The tool's state arrives as ACP `plan` updates; each update replaces the widget (`todo_write 2/5`, ✓ done / ◉ in progress / ○ pending) and the widget clears when the Devin session binding resets (`/devin reset`, session switch, leaving the Devin provider). The latest task list follows a restorable Pi session binding across reloads even though Devin's `session/load` does not replay ACP `plan` updates; attaching an unrelated Devin session clears the old tasks. The footer status now shows only `fast:on|off|n/a` — the selected model is already displayed by pi itself.

### Patch Changes

- [#115](https://github.com/TianZuo555/pi-extensions/pull/115) [`2b5fbad`](https://github.com/TianZuo555/pi-extensions/commit/2b5fbaddba5f26a12aa4967f6276eb3b103c3573) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Keep per-request token accounting when Devin's main-chain-only turn statistics arrive, so Fusion sidekick usage and the final requests are not lost from Pi's session totals.

## 0.4.0

### Minor Changes

- [#107](https://github.com/TianZuo555/pi-extensions/pull/107) [`d8207ca`](https://github.com/TianZuo555/pi-extensions/commit/d8207cabc05b23da242fd9c2ba9105acb5e4d8ba) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Adapt to devin 3000.11.x and flatten the model catalog to family granularity. `session/set_config_option` now validates `model` against one anchor row per family (e.g. `swe-2-high`) and carries the variant dimensions in separate `thought_level`/`speed` config options, so the old concrete-row writes (`swe-2-medium`, `claude-opus-5-max`, …) failed every devin turn with `Invalid params`; a resolved row is now written as the closest advertised triple (family anchor + clamped effort + speed), planned against the option set refreshed by each write, and builds that accept row ids directly keep the single-write behavior. Fusion rows (whose ids embed a mid-tier `-fast` and a verbatim sidekick half) map onto their advertised anchor of the same lead family + sidekick with the LEAD's effort and tier, instead of being sent as rejected concrete rows. Accordingly, `-fast` model variants are gone: pi models are `devin/<family>` (plus `-1m` context variants), pi's thinking level drives `thought_level` (`:off`/unset requests no thinking), and the new standalone `/devin-fast` command toggles the priority serving tier (`speed`; `on`/`off` sets it explicitly, `/devin fast` works too), persisted in `~/.pi/devin-acp/settings.json` and shown in the footer as `devin:<model> · fast:on|off|n/a`. Turns now bill the selected row's pricing instead of the registered standard-tier group cost, so `/devin-fast` runs are no longer undercharged. Pricing is snapshotted on the ACP turn and reused across replay segments, including errors and cancellations; toggling fast mid-turn or refreshing the catalog only changes pricing for subsequent turns.

## 0.3.6

### Patch Changes

- [#103](https://github.com/TianZuo555/pi-extensions/pull/103) [`09ffcc1`](https://github.com/TianZuo555/pi-extensions/commit/09ffcc1a46be322022adc08034dccd9c323af120) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Support Pi 0.87's normalized provider transcripts and JSON-compatible tool calls. Custom providers now resolve system instructions from transcript messages without replaying them as conversation history, remote Responses compaction normalizes its provider context, and commit generation folds its system prompt into a transcript before calling the raw provider.

## 0.3.5

### Patch Changes

- [#94](https://github.com/TianZuo555/pi-extensions/pull/94) [`bec80c9`](https://github.com/TianZuo555/pi-extensions/commit/bec80c96674cd7e004e74c32e6de42a489e59be8) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Preserve Devin text/thinking stream order when ACP omits message IDs, so a final answer remains the last rendered block.

## 0.3.4

### Patch Changes

- [#91](https://github.com/TianZuo555/pi-extensions/pull/91) [`76806f2`](https://github.com/TianZuo555/pi-extensions/commit/76806f24b55ebe41ac508911b4df7c8678b325f0) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Calculate costs from the original Devin token counters before adapting
  aggregate usage for pi's overflow heuristic, and cap aggregated uncached
  input as well: the shift previously ran before pricing (repricing moved
  tokens at the cacheWrite rate) and was capped at cacheRead, so a
  mostly-uncached aggregate still exceeded the context window and tripped
  spurious compaction. Token totals are preserved; the synthetic counters
  must not be used to recalculate costs.

- [#91](https://github.com/TianZuo555/pi-extensions/pull/91) [`76806f2`](https://github.com/TianZuo555/pi-extensions/commit/76806f24b55ebe41ac508911b4df7c8678b325f0) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Stop listing in-turn devin ops as running after a cancelled turn. When a
  prompt is cancelled (pi-side `esc` or a superseding prompt) while devin
  tool calls are in flight and no trailing terminal update ever arrives,
  the entries stayed in the live-op tracker forever — the status bar kept
  reporting `devin: N running` and `/devin-tasks` kept listing the dead
  entries until each was dismissed by hand with `d`. A cancelled prompt's
  in-turn ops (no background shell id) are now swept from the tracker
  after a short grace window that lets devin's own trailing terminal
  updates land first; swept ids are tombstoned so late re-notifications
  cannot resurrect them, detached background shells stay listed, and a
  newer turn's ops started inside the window are never touched.
  
  Fixes [#92](https://github.com/TianZuo555/pi-extensions/issues/92)

- [#91](https://github.com/TianZuo555/pi-extensions/pull/91) [`76806f2`](https://github.com/TianZuo555/pi-extensions/commit/76806f24b55ebe41ac508911b4df7c8678b325f0) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Relay only the "Pi documentation" section of pi's instruction snapshot
  to devin instead of the whole snapshot. The rest describes pi's own tool
  surface (wrong for devin's tools) or duplicates what devin already loads
  itself — AGENTS.md rules, user skills, the session cwd — so it was dead
  context weight on every prompt. The doc paths are the one part devin
  cannot discover alone; when the section is absent the full snapshot is
  still sent as a fallback.

- [#91](https://github.com/TianZuo555/pi-extensions/pull/91) [`76806f2`](https://github.com/TianZuo555/pi-extensions/commit/76806f24b55ebe41ac508911b4df7c8678b325f0) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Show the account quota in the footer status line while a Devin model is
  selected (`devin 100% day 81% wk`, refreshed with a 60s cache on session
  start, model select, and turns — same convention as the pi-usage
  extension), and report real context occupancy in `usage.totalTokens`
  instead of summed internal-request usage. The summed prompts could exceed
  the model window on multi-request segments, tripping pi's auto-compaction
  threshold (and silent-overflow heuristic) and printing
  "Auto-compaction cancelled" on every vetoed attempt; the occupancy signal
  keeps the context gauge truthful while the session_before_compact veto
  stays as the guardrail for genuinely full contexts.

- [#91](https://github.com/TianZuo555/pi-extensions/pull/91) [`76806f2`](https://github.com/TianZuo555/pi-extensions/commit/76806f24b55ebe41ac508911b4df7c8678b325f0) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Keep finished devin operations from resurrecting in /devin-tasks. Devin
  re-emits a non-terminal `tool_call_update` under the original toolCallId
  when a later `get_output` read (or late PTY output) touches a completed
  exec session, which brought the op back as "running" forever. Tool-call
  ids that reach a terminal status or `terminal_exit` are now tombstoned so
  late re-notifications can no longer re-open them; genuinely running ops
  still track normally, and `d` dismissal behavior is unchanged.

- [#91](https://github.com/TianZuo555/pi-extensions/pull/91) [`76806f2`](https://github.com/TianZuo555/pi-extensions/commit/76806f24b55ebe41ac508911b4df7c8678b325f0) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Prevent pending quota requests from restoring the Devin footer after a
  model switch or session shutdown, while retaining account-wide caching
  and request deduplication. Footer bookkeeping moves to a dedicated
  `createDevinQuotaStatus` helper whose generation counter invalidates
  older publications and rechecks the live provider after the await.

- [#91](https://github.com/TianZuo555/pi-extensions/pull/91) [`76806f2`](https://github.com/TianZuo555/pi-extensions/commit/76806f24b55ebe41ac508911b4df7c8678b325f0) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Show the account quota Devin CLI's `/usage` reports at the top of `/devin-usage`.
  
  `/devin-usage` only rendered the session snapshot devin pushes over ACP, and ACP has no pull-based quota request — so the daily/weekly quota windows, reset times, and extra-usage balance were invisible from pi. The report now also calls `SeatManagementService/GetUserStatus` (the same Connect RPC Devin CLI's `/usage` uses) with the `windsurf_api_key` from `~/.local/share/devin/credentials.toml`, and renders a leading Quota section in devin's own wording: `0% used · resets in 19h 1m` for the daily window, `19% used · resets Sep 20, 4:00 PM (UTC+8)` for the weekly one, `Extra usage balance  $10.00`, and the `No quota consumed yet in this session.` tail on fresh sessions. Fetch failures degrade to a `Quota: unavailable — <reason>` row instead of hiding the section; the session view (context bar, tokens/cost, last-turn stats) is unchanged below it.

## 0.3.3

### Patch Changes

- [#89](https://github.com/TianZuo555/pi-extensions/pull/89) [`9d04632`](https://github.com/TianZuo555/pi-extensions/commit/9d046329746ecc7e2298d71b849e4fe2ea46b6d0) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Restore pi's live footer stats during devin turns via per-message delta billing.
  
  Previously usage was attached only to the turn's terminal assistant message, so pi's built-in footer (`↑ ↓ R CH $`) showed nothing for the whole duration of a devin turn. The turn controller now tracks the turn's billable token total and each pi assistant message (replay segment or terminal) persists only the not-yet-billed share: the footer fills live while the session log still sums to the authoritative total.
  
  Accounting follows the real ACP wire protocol: each internal request's `usage_update` is emitted twice identically and `PromptResponse.usage` echoes the last request, so request snapshots accumulate after consecutive-identical dedup; `_cognition.ai/turn_stats` cumulative sums remain authoritative — they replace the accumulated total and block later request-level snapshots. Failed or aborted turns bill only the observed remainder.
  
  Stop forwarding pi's auto-compaction triggers to devin. Because the merged turn usage inflated the context gauge past 100%, pi's threshold check kept firing and each forwarded `/compact` forced an unnecessary devin compaction. Only a manual `/compact` still routes to devin's own `/compact`; threshold and overflow triggers are vetoed silently — devin compacts itself internally and reports it via `compaction_update`.

## 0.3.2

### Patch Changes

- [#82](https://github.com/TianZuo555/pi-extensions/pull/82) [`019ac2c`](https://github.com/TianZuo555/pi-extensions/commit/019ac2c89d708409903054000219a853d9c5d3aa) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Surface Devin's backend reconnects in pi: the `devin acp` child emits a `_cognition.ai/connection_retry` notification per attempt while a prompt waits on its stream, which previously left pi's turn looking frozen with no explanation. The status-bar widget now shows `devin: connection failed (attempt N/M), retrying…` (or `connection lost` for mid-stream drops) with the elapsed retry time, clearing as soon as updates resume, the turn settles, or the state goes stale; `/devin` status reports the same retry state. Retries attributed to other ACP sessions are ignored.

- [#85](https://github.com/TianZuo555/pi-extensions/pull/85) [`64b6330`](https://github.com/TianZuo555/pi-extensions/commit/64b633091fd777c5424dfd63d5c4df889aa93c71) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix devin turn usage being both double-counted and under-counted in pi's session log (and therefore `/tokens`).
  
  - A turn's activity feed now starts when its `session/prompt` goes out: until then the session listener stays state-only (updates still refresh the `/devin-usage` snapshot but never reach the turn). Previously the listener was wired to the fresh turn during session setup, so pre-prompt updates — the `session/load` replay tail carrying the loaded session's stored `usage_update` snapshot, or a superseded turn's trailing update — seeded the turn's `lastUsage` with prior-turn totals, and a turn aborted or failed before devin reported live usage persisted them again, double-counting tokens.
  - Billable usage now comes from `_cognition.ai/turn_stats` responseDimensions, whose cumulativeMetric rows sum every internal model request of the turn (devin's `usage_update`/`PromptResponse.usage` only report the last request, so multi-request turns were badly under-counted). Each `session/prompt` is stamped with a `cognition.ai/clientMessageId` that devin echoes as `turnClientMessageId`, so a turn claims only its own stats — replayed or superseded-turn stats can't contaminate it. Once cumulative sums land they are authoritative: trailing last-request snapshots merge without overwriting token fields.

- [#82](https://github.com/TianZuo555/pi-extensions/pull/82) [`019ac2c`](https://github.com/TianZuo555/pi-extensions/commit/019ac2c89d708409903054000219a853d9c5d3aa) Thanks [@TianZuo555](https://github.com/TianZuo555)! - `/devin-tasks` no longer strands dead ops forever. Devin emits a tool call's terminal update right after a turn is cancelled — exactly while the superseded turn's listener generation is stale — and those updates were dropped entirely, leaving completed execs listed as running. Session-scoped op tracking now survives supersession (only delivery into the turn stream stays generation-gated), and an unexpected `devin acp` process exit drops the tracked ops it owned. For entries already stranded, `d` in `/devin-tasks` (dashboard and detail view, plus a confirm in the non-TUI picker) removes an op from the list without messaging Devin; an op that is genuinely still running re-adds itself on its next update.

- [#82](https://github.com/TianZuo555/pi-extensions/pull/82) [`019ac2c`](https://github.com/TianZuo555/pi-extensions/commit/019ac2c89d708409903054000219a853d9c5d3aa) Thanks [@TianZuo555](https://github.com/TianZuo555)! - `/devin-tasks` now returns to the operations dashboard after a kill request (confirmed, declined, or refused for in-turn ops) instead of exiting the picker, matching `/ps` — several background shells can be stopped per visit. `/devin tasks` (the removed space form) now prints a pointer to `/devin-tasks` instead of an unknown-argument error that still listed `tasks` as valid. Detached-shell cleanup on shutdown also fixes a dead guard: Node has no `process.getpgrp`, so pi's own process group is now read from the same `ps` snapshot used to find devin's descendants.
  
  Two failure-path fixes: bootstrap history and system-instruction resources are now committed only once devin answers the prompt request — a throwing `transformPrompt` hook or a failed prompt no longer makes the retry lose that context (the resources are re-attached instead). Completion callbacks are guarded by binding generation, client, and session identity so late results cannot clear a new binding's bootstrap state, and an out-of-order completion within one binding can no longer overwrite a newer instruction commit. And `/devin yolo off` applies the remote mode change before persisting the setting, so a failed `setMode` can no longer leave devin in bypass while pi reports yolo off, and a failed preference write is reported without desynchronizing the applied mode from the in-memory policy.

- [#82](https://github.com/TianZuo555/pi-extensions/pull/82) [`019ac2c`](https://github.com/TianZuo555/pi-extensions/commit/019ac2c89d708409903054000219a853d9c5d3aa) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Record ACP usage once on the terminal assistant message, preserving cache-read/cache-write classification and cost even when cache metadata arrives after tool replay segments. Failed and aborted streams retain their latest observed usage; summary sessions merge streamed usage with canonical prompt-response totals. Normalize nullable ACP cache counters and include cache writes without double counting input. Live usage remains available through /devin-usage; replay-only messages intentionally carry zero billable usage.

## 0.3.1

### Patch Changes

- [#80](https://github.com/TianZuo555/pi-extensions/pull/80) [`6008953`](https://github.com/TianZuo555/pi-extensions/commit/60089534307bbd3306c80cae06e1a9e5a7c6baa9) Thanks [@TianZuo555](https://github.com/TianZuo555)! - `/devin-tasks` now returns to the operations dashboard after a kill request (confirmed, declined, or refused for in-turn ops) instead of exiting the picker, matching `/ps` — several background shells can be stopped per visit. `/devin tasks` (the removed space form) now prints a pointer to `/devin-tasks` instead of an unknown-argument error that still listed `tasks` as valid. Detached-shell cleanup on shutdown also fixes a dead guard: Node has no `process.getpgrp`, so pi's own process group is now read from the same `ps` snapshot used to find devin's descendants.
  
  Two failure-path fixes: bootstrap history and system-instruction resources are now committed only once devin answers the prompt request — a throwing `transformPrompt` hook or a failed prompt no longer makes the retry lose that context (the resources are re-attached instead). Completion callbacks are guarded by binding generation, client, and session identity so late results cannot clear a new binding's bootstrap state, and an out-of-order completion within one binding can no longer overwrite a newer instruction commit. And `/devin yolo off` applies the remote mode change before persisting the setting, so a failed `setMode` can no longer leave devin in bypass while pi reports yolo off, and a failed preference write is reported without desynchronizing the applied mode from the in-memory policy.

- [#80](https://github.com/TianZuo555/pi-extensions/pull/80) [`6008953`](https://github.com/TianZuo555/pi-extensions/commit/60089534307bbd3306c80cae06e1a9e5a7c6baa9) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Record ACP usage once on the terminal assistant message, preserving cache-read/cache-write classification and cost even when cache metadata arrives after tool replay segments. Failed and aborted streams retain their latest observed usage; summary sessions merge streamed usage with canonical prompt-response totals. Normalize nullable ACP cache counters and include cache writes without double counting input. Live usage remains available through /devin-usage; replay-only messages intentionally carry zero billable usage.

## 0.3.0

### Minor Changes

- [#78](https://github.com/TianZuo555/pi-extensions/pull/78) [`6beeb93`](https://github.com/TianZuo555/pi-extensions/commit/6beeb934918b9be78e5cb6e788fd8683b7837e4c) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Add `/devin-usage` (also `/devin usage`): a report of the usage devin reports over ACP — context-window occupancy bar, cumulative session tokens/cost (`usage_update` counters, `cost`, `totalCreditCost`/`totalAcuCost`), and last-turn stats — rendered in /usage's padded-label style with the server's own `responseDimensions` grouping, so new usage dimensions surface without a client update. The runtime snapshot now carries the merged `usage` object, and `cachedWriteTokens`, `creditCost`, `acuCost`, and `responseDimensions` are captured from `usage_update`/`agent_stopped` payloads.
  
  Live-op labels no longer fall back to "(untitled op)" when devin omits the tool-call title — the status widget and `/devin-tasks` views now synthesize a label from the call summary (e.g. `execute · sleep 60`, from kind/locations/rawInput) or the devin tool name, so running operations are identifiable at a glance.

- [#77](https://github.com/TianZuo555/pi-extensions/pull/77) [`4ca04fa`](https://github.com/TianZuo555/pi-extensions/commit/4ca04fac40e0ae531cba76e0999d10e60a1c379c) Thanks [@TianZuo555](https://github.com/TianZuo555)! - `/devin tasks` is now the standalone command `/devin-tasks` with /ps-style overlay interaction: `enter` opens a read-only detail view for the selected devin operation (invocation info tab with id/title/kind/tool/status/elapsed/scope/locations/input, plus a live `output` tab that tails devin's streamed tool output with j/k scrolling, page keys, and g/G), and `x` requests a stop. Previously both keys jumped straight to the kill confirmation. When an operation settles while being inspected, the view freezes on its last snapshot and stops offering kill; killing still only applies to detached background shells, which pi can only ask devin to stop.
  
  Also fixes a process leak: devin background shells are detached into their own process groups and used to survive `/new`, `/quit`, and `/reload` as orphaned processes after the `devin acp` child was killed — still running, but invisible to `/devin-tasks` and unreachable by the fresh session. The runtime now kills those detached descendant groups (SIGTERM, then SIGKILL) before the acp child dies; the child's own process group, shared with pi, is never signalled. POSIX only — Windows falls back to a best-effort `taskkill /T` tree kill.

## 0.2.0

### Minor Changes

- [#65](https://github.com/TianZuo555/pi-extensions/pull/65) [`5fb65bd`](https://github.com/TianZuo555/pi-extensions/commit/5fb65bd86b38fb558bab53ba12bce050dd73979e) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Emit `agent:input_required` (and legacy `herdr:blocked`) on the shared event bus while a devin permission prompt waits on the user, so integrations such as Herdr can surface the blocked state and notification sound. Route every pi compaction trigger — manual `/compact`, threshold, and overflow recovery — to devin's own `/compact` instead of silently skipping non-manual ones, forwarding custom instructions and rate-limiting auto forwards. Add a persisted `yolo` setting (`/devin yolo on|off`, stored at `~/.pi/devin-acp/settings.json`) that pins devin to bypass mode and auto-approves any permission request that still arrives.

- [#65](https://github.com/TianZuo555/pi-extensions/pull/65) [`5fb65bd`](https://github.com/TianZuo555/pi-extensions/commit/5fb65bd86b38fb558bab53ba12bce050dd73979e) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Rebuild `/devin tasks` as a `/ps`-style fullscreen overlay (mirroring the background-terminals dashboard): bordered op list with j/k selection, live 1 Hz refresh, elapsed times, background-shell markers, and enter/x to ask devin to kill a background shell; non-TUI modes keep the select/confirm flow. Fix the devin runtime dying with "ManagedRuntime disposed" after pi `/new`, `/resume`, or `/fork`: extensions are cached and reused across session replacement, so those now suspend the runtime (kill the `devin acp` child, drop the session binding) and only quit/`/reload` close it for good — `/new` now really starts a fresh devin session on the next turn.

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
