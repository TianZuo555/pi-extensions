# Plan: Pi Tool & Skill Bridge for agy

Status: **planned, not started**. Written 2026-08-21 after the v0.2.3 tool-card /
background-task work. This document records the research and the phased plan;
nothing here is implemented yet.

## Goal

Let agy (Google Antigravity CLI) use pi's extension tools and pi's Agent
Skills during its turns — the same way `pi-cursor-sdk` bridges them into
Cursor — so `antigravity/*` models in pi get pi's ecosystem (web search,
subagents, repo skills, custom tools) instead of only agy's 57 built-in tools.

## Reference: how pi-cursor-sdk does it for Cursor

Source: https://github.com/fitchmultz/pi-cursor-sdk (README, 2026-08).

1. **Pi tool bridge (MCP-backed).** The extension runs a loopback MCP server
   on `127.0.0.1` that exposes the *active* pi tools as collision-safe
   `pi__<name>` tools. When Cursor calls one, the bridge:
   - queues the MCP call,
   - emits a normal pi `toolCall` into the ongoing provider stream,
   - waits for the matching pi `toolResult`,
   - resolves the result back into the **same live Cursor run**.
   It deliberately never calls pi tool `execute()` handlers directly — pi
   keeps ownership of execution semantics (hooks, permissions, confirmations,
   renderers, abort). Overlapping built-in pi tools (`read`, `bash`, `write`,
   `edit`, `grep`, `find`, `ls`) are hidden by default because Cursor has
   native equivalents; `PI_CURSOR_EXPOSE_BUILTIN_TOOLS=1` opts in.
   `PI_CURSOR_PI_TOOL_BRIDGE=0` disables the bridge entirely (rollback flag).
2. **Skills.** When pi has Agent Skills loaded, the extension rewrites pi's
   skill catalog into the prompt and exposes `cursor_activate_skill` as
   `pi__cursor_activate_skill`; Cursor calls it with a skill name to load the
   full `SKILL.md` + bundled resource list. If the bridge is disabled, the
   catalog instead instructs Cursor to read the `SKILL.md` paths directly.
3. **Callable-surfaces manifest.** A compact block injected into the prompt on
   bootstrap sends lists the current `pi__*` names and tells the model which
   surface (host-native vs bridge) to prefer.
4. **AGENTS.md dedup.** Because Cursor loads project `AGENTS.md`/`CLAUDE.md`
   itself, the extension strips pi's overlapping `<project_instructions>`
   blocks via a `before_agent_start` hook to avoid duplicate injection.

## What agy supports (verified 2026-08-21)

- **First-class MCP.** `agy mcp add|remove|list|enable|disable` with
  `--type stdio` (default) and `--type http` (URL auto-detected). Servers are
  stored in the global `~/.gemini/antigravity-cli/settings.json`. The `init`
  event of every stream-json run lists MCP-related built-ins:
  `call_mcp_tool`, `list_resources`, `read_resource`.
- **Skills exist but are disabled in our flow.** Built-in skills live in
  `~/.gemini/antigravity-cli/builtin/skills/` (e.g. `antigravity_guide`).
  `--disable-slash-commands` — which we always pass to stop the built-in
  `antigravity_guide` skill from hijacking headless turns — disables "slash
  command **and skill expansion**" in print mode. So agy's native skill
  invocation is unavailable in pi-antigravity turns.
- **Settings are global.** No per-run MCP flag was found in `agy --help`;
  there may be per-project config (unverified). We already manage
  `permissions.allow` rules in that file for headless runs.
- **Headless quirks we already handle** (context for the bridge design):
  - print mode ignores the process cwd; the workspace must be registered via
    `--add-dir <cwd>`;
  - long-lived commands become agy "background tasks": the tool step stays
    `ACTIVE` forever, the turn ends `ERROR` "timeout waiting for response",
    and the spawned process is orphaned (handled by `/agy-tasks`);
  - the turn can hang on such tasks, so the conversation id is tracked
    eagerly from the first stream event, not from turn completion.

## Current architecture the bridge will plug into

- `lib/agy-client.ts` spawns `agy --print … --output-format stream-json` per
  turn and folds NDJSON events into `AgyActivity` items
  (`tool_start`/`tool_done`/`tool_error`/`text`/`usage`/`result`).
- `src/runtime.ts` keeps one `AgyTurnController` per agy run; sequential pi
  requests re-attach to the still-running turn via `beginStreamTurn`
  (same-prompt matching) — this is how one agy run spans multiple pi
  tool-use turns.
- `src/provider.ts` ends the assistant message with `stopReason: "toolUse"`
  at each completed agy tool step; pi then executes the display-only `agy`
  wrapper tool, which returns the *recorded* agy result from
  `lib/replay.ts` (`AgyReplayStore`). No tool work runs inside pi today.
- `index.ts` registers the provider, the `agy` wrapper tool, the `agy` and
  `/agy-tasks` commands, and reference Gemini pricing.

The bridge reuses exactly this skeleton — the difference is that bridged
tools *execute in pi* instead of being display-only replay.

## Phased plan

### Phase 1 — Pi tool bridge via loopback HTTP MCP

1. Extension hosts an MCP server (streamable HTTP) on `127.0.0.1:<port>` for
   the lifetime of the pi session.
2. Register it once: `agy mcp add pi-bridge --type http http://127.0.0.1:<port>`;
   `agy mcp disable pi-bridge` (or remove) on `session_shutdown`.
3. Expose only **non-overlapping active pi tools** as `pi__<name>` (hide
   `read`, `bash`, `write`, `edit`, `grep`, `find`, `ls`; agy has native
   equivalents). Snapshot from pi's active tool registry per run, like
   cursor-sdk.
4. Call flow (mirrors replay, but executing):
   - agy calls `pi__<tool>` → our HTTP handler records a pending call and
     pushes a synthetic activity into the live `AgyTurnController`;
   - the provider ends the pi turn with `stopReason: "toolUse"` for the *real*
     pi tool (real cards, hooks, permissions, abort);
   - pi executes the tool; the `toolResult` lands in context;
   - the next `streamAntigravity` request re-attaches to the running agy turn,
     sees the pending bridge call, and resolves the HTTP response with the
     toolResult content;
   - agy continues with the result in the same conversation.
5. Correlation: a pending-call map keyed by MCP call id, resolved on
   re-attach; unresolved calls fail closed on turn end/abort.
6. Rollback/isolation flags mirroring cursor-sdk:
   `PI_ANTIGRAVITY_PI_TOOL_BRIDGE=0`, maybe
   `PI_ANTIGRAVITY_EXPOSE_BUILTIN_TOOLS=1`.

Risks / details to design carefully:
- **Permissions:** headless agy must auto-approve MCP tool calls. We already
  pass `--dangerously-skip-permissions`, but verify MCP calls are covered;
  otherwise add an allow rule (`mcp__pi-bridge` shape TBD) to
  `settings.json` alongside the existing `permissions.allow` handling.
- **Timeouts:** agy turn timeout is 600s; long-running pi tools (background
  terminals) may outlive it. Decide: cap bridge tool timeout, or stream a
  "still running" placeholder. cursor-sdk raises MCP tool timeout to 3600s.
- **Re-attach ambiguity:** `beginStreamTurn` matches on same prompt; bridged
  turns must be distinguishable from user retries (pending-call map keyed by
  call id should disambiguate).
- **Schema bloat:** only expose a bounded set of tools; consider a
  `pi__mcp`-style meta-tool if the registry is large.

### Phase 2 — Skills via the bridge

agy's native skill expansion is disabled by `--disable-slash-commands`, so do
it cursor-sdk-style:

1. Inject the pi skill catalog (name + one-line description) into the agy
   prompt on bootstrap sends. Source it from pi's `before_agent_start`
   `event.systemPromptOptions` (loaded skills with name/description/path) so
   we respect `--no-skills`, `pi config` enable/disable, and `/reload` —
   snapshot per bootstrap send, never cached across reloads. Keep entries to
   name + one-liner only: an oversized or interactive-only-heavy catalog can
   derail headless turns the same way the built-in `antigravity_guide` skill
   does.
2. Expose `pi__activate_skill` as a bridge tool that returns the full
   `SKILL.md` content + bundled resource list for a named skill. Resolve
   relative resource references (scripts, docs) to absolute paths at return
   time — SKILL.md files reference resources relative to their own directory,
   and raw relative paths would leave agy unable to locate them.
3. If the bridge is disabled, fall back to instructing agy to read the
   `SKILL.md` paths directly (they are absolute local paths — works because
   agy runs locally with workspace access). **Verified 2026-08-21** (agy
   1.1.17): headless agy read `/Users/tian/.pi/agent/skills/herdr/SKILL.md` —
   outside the `--add-dir <cwd>` workspace — under
   `--dangerously-skip-permissions --disable-slash-commands` and returned its
   frontmatter unprompted (`PROBE_RESULT name=herdr`, exit 0). The
   no-bridge fallback works for user-level skills; keep an eye on it across
   agy upgrades since it depends on permission behavior, not a guarantee.

### Phase 3 — Polish

1. **AGENTS.md dedup:** first verify whether agy print mode loads project
   `AGENTS.md` (Gemini CLI does). If yes, strip pi's overlapping
   `<project_instructions>` blocks for `antigravity/*` models the way
   cursor-sdk does, with a preserve flag.
2. Auto-manage the bridge permission allow-rule in `settings.json`.
3. Callable-surfaces manifest block in the prompt (list current `pi__*`
   names, prefer-bridge guidance).
4. Card rendering for bridged calls should be indistinguishable from native
   pi tool cards (they already will be — they *are* native pi tool calls).

## Open questions (verify before coding Phase 1)

1. Does agy headless actually **invoke** MCP tools under
   `--dangerously-skip-permissions`, and do MCP calls appear as normal
   `tool` steps in the stream (so existing cards render them)? Probe with a
   trivial echo MCP server.
2. Does agy print mode load project `AGENTS.md`? (Determines Phase 3.1.)
3. Does the bridge server need to be reachable at agy spawn time only, or per
   call? (Affects whether we can lazily start it and whether
   `session_shutdown` disable is enough.)
4. Is there per-project MCP configuration (e.g. workspace
   `.gemini/settings.json`) so we avoid writing global state? If not, decide
   how to scope/clean up the global `pi-bridge` entry.
5. How does agy name MCP tools in `tool_info` (e.g. `call_mcp_tool` with a
   server/tool parameter vs `mcp__server__tool`)? Determines card rendering
   and the pending-call correlation on the agy side — for Phase 1 and for
   `pi__activate_skill` in Phase 2 alike.
6. ~~Can headless agy read files under `~/.pi/agent/skills/` (outside the
   `--add-dir <cwd>` workspace) without permission prompts?~~ **Yes —
   verified 2026-08-21** via probe script (`bash /tmp/agy-skill-probe.sh`,
   run through Herdr): agy 1.1.17 print mode with
   `--dangerously-skip-permissions --disable-slash-commands --add-dir <cwd>`
   read `~/.pi/agent/skills/herdr/SKILL.md` and echoed its frontmatter name.
   Phase 2's no-bridge fallback is viable.
