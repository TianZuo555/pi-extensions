---
"@tian.zuo/pi-antigravity": patch
---

Move the per-tool-start orphan snapshot off the event loop: a new tool step now queues a coalesced async `ps` scan instead of running `spawnSync("ps")` inside the driver's line handler, so tool bursts no longer stall the TUI. A turn that dies while a scan is still queued settles only after the snapshot lands, preserving the "recorded before agy exits" guarantee.

Task scans no longer read whole task logs on every poll — `listAgyTasks` reads only an 8 KiB head for the description line (widget rescans every 2 s, the dashboard every 1 s, and a long-lived task's log grows without bound), and a log deleted mid-scan no longer fails the whole listing.

Subagent steps are no longer invisible: agy emits `invoke_subagent`/`send_message`/`manage_subagents` as `step_type: "subagent"` with the payload under `subagent_info` (not `tool_info`), and the reducer used to drop them entirely — no tool card, and `/agy-subagents` always reported nothing. They now fold into normal tool activities with normalized args, so spawns render as cards and the roster finally populates.

Stale-session safety: every session-bound ctx getter throws once pi invalidates the extension runner, and `agent_settled`/`model_select` can still be dispatched around a session swap or shutdown. Handlers now probe ctx before touching it, and `persistConversationState` reads its fields before awaiting — the `extension_error` noise seen when a turn settles during `/new` or quit is gone.

Smaller fixes: `stopAgyTask` no longer double-counts a holder already reached by its process-group signal; `/agy` reports the scheduling context window (1m) instead of a hardcoded `185k`; `/agy` with arguments now lists every `agy-*` command; navigating the session tree clears the subagent roster like `/agy-reset` does; the wrapper-tool activation sync tolerates unavailable tool APIs like the other tool callers; one-shot `agy` spawns and the `/usage` exec path now pass `windowsHide`; and the duplicated `agyBrainDir()` lives in `lib/agy-paths.ts`.
