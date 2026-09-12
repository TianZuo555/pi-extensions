# Plan: `pi-devin-acp` — Devin models inside pi via `devin acp` (ACP)

pi stays the UI (chat, model picker, tool cards, sessions); the selected Devin
model runs underneath through a persistent `devin acp` child speaking the
Agent Client Protocol (JSON-RPC over stdio). Same shape as `pi-antigravity`
(stream-json driver) and `pi-cursor-sdk` (`@cursor/sdk` runtime), but the wire
protocol is standard ACP plus Cognition extensions.

References:

- `packages/pi-antigravity` — in-repo reference for provider registration,
  streamSimple adaptation, display-only replay wrapper, conversation-state
  persistence, diagnostics.
- `~/Workspace/pi-cursor-sdk` (fitchmultz/pi-cursor-sdk) — reference for model
  catalog cache/fallback, native tool replay, lazy provider loading.
- `@agentclientprotocol/sdk@1.4.0` — official ACP TS SDK
  (published 2026-08-20; typed schema + generic `onRequest`/`onNotification`
  for custom methods).

## What `devin acp` provides (verified by live probe, devin 3000.10.21)

### Agent methods (client → `devin acp`)

| Method | Verified | Notes |
| --- | --- | --- |
| `initialize` | yes | returns caps below |
| `authenticate` | advertised | `authMethods: [{id:"devin-browser"}]`; also reads `WINDSURF_API_KEY` / `devin auth login` creds |
| `session/new` | yes | `{cwd, mcpServers[]}` → `{sessionId, modes, configOptions}` |
| `session/load` | partial | `loadSession: true`; probe on a same-process session returned `session_not_found` — resume semantics need a cross-process probe |
| `session/list` | yes | `{sessionId, cwd, title, updatedAt, _meta: {createdAt, isLocked}}` — shared session DB; locked = open elsewhere |
| `session/delete` | advertised | `sessionCapabilities.delete` |
| `session/prompt` | yes | `{sessionId, prompt:[ContentBlock]}` → `{stopReason, usage, _meta.userMessageId}` |
| `session/cancel` | standard | notification; bind to pi abort |
| `session/set_mode` | yes | modes: `accept-edits`(Code), `ask`, `plan`, `bypass` |
| `session/set_config_option` | yes | `{configId:"model", value:"claude-sonnet-5-low"}` switched the session model; `configId:"mode"` also present as a select option |
| `session/resume`, `session/fork`, `session/close` | in SDK | availability TBD by probe |

### Agent capabilities

- `promptCapabilities`: image **true**, embeddedContext **true**, audio false —
  pi images can be sent as content blocks; pi history could ride as an embedded
  `resource` block instead of inlined text (decision below).
- `mcpCapabilities`: http/sse **false** — `session/new` accepts only **stdio**
  MCP servers.
- Cognition `_meta` extensions: multiRootWorkspace, sessionRename,
  sessionShare, documentLifecycle, userEdits, terminalLifecycle, userConfig,
  userShellCommand, editableCommands, commandRevision, chains, megaplan,
  ruleMentions.

### `session/update` kinds observed

`agent_message_chunk`, `agent_thought_chunk`, `tool_call`/`tool_call_update`
(ACP-standard: kind, title, status, locations, content incl. `diff`,
rawInput/rawOutput), `plan`, `usage_update` (`used`/`size` + `_meta`
inputTokens/outputTokens/subagent_context), `available_commands_update`
(devin's slash commands + skills as commands), `current_mode_update`,
`config_option_update`, `session_info_update` (title). SDK schema also covers
`compaction_update`, `user_message_chunk`.

### Cognition notifications observed

`_cognition.ai/agent_stopped` (turn stats: toolCalls, filesChanged,
commandsRun, inputTokens, outputTokens, ttftMs, tokensPerSec, totalTimeMs,
modelLabel) — feeds usage + token-speed; `_cognition.ai/turn_stats`,
`_cognition.ai/thinking_complete`, `_cognition.ai/output` (log channels),
`_cognition.ai/mcp/serversChanged`.

### Client capabilities the server understands

(from its initialize log) `fs.read`, `fs.write`, `terminal`, `terminal_auth`,
`subagents`, `elicitation`, `partial_content`, `multi_root`,
`grouped_options`, `mcp`, `plugins`, `editor_context`, `terminal_context`,
`load_stats`, `wiki`, `revert`, `workspace_dir_commands`, `browser_preview`,
`clipboard_write`, `local_tools`, etc. v1 advertises **fs+terminal false**:
devin self-executes tools and reports them via `tool_call` updates (verified
working in the probe).

### Client → must implement

`session/update` handler; `session/request_permission` (route to
`ctx.ui.select`); optionally later `fs/read_text_file`,
`fs/write_text_file`, `terminal/*`.

### Out-of-band discovery

- `devin models list` — full catalog: 47 families, concrete model IDs with
  thinking suffixes (`-none/-low/-medium/-high/-xhigh/-max`), `-fast`/
  `-priority` variants, context windows and pricing. Cheaper than an ACP
  handshake for registration.
- `devin version` → `devin 3000.10.21 (611c1cba)` for doctor.
- `devin acp --model <m>` / `DEVIN_MODEL` — default model per ACP session;
  `--agent-type summarizer|review`; `--refusal-fallback`.

## Architecture

```
pi extension "devin"
  └─ AcpDriver          persistent `devin acp` child (one per pi process;
                        sessions are per-session/new|load, share one conn)
       └─ ClientSideConnection (@agentclientprotocol/sdk) or thin NDJSON RPC
            ├─ session/new · session/load · session/prompt · cancel
            ├─ set_mode / set_config_option (mode + model sync)
            └─ session/list · session/delete · authenticate
  └─ streamDevin()      streamSimple: pi turn → session/prompt → pi events
  └─ DevinReplayStore + `devin` wrapper tool  display-only tool cards
  └─ conversation-state persistence  pi.appendEntry(ACP_SESSION_ENTRY,…)
  └─ /devin commands    status · reset · models · sessions · mode · login · doctor
```

Key structural differences from pi-antigravity:

- **No NDJSON dialect to reverse-engineer** — ACP is typed; the SDK handles
  framing, schema, and (via generic `onRequest`/`onNotification` overloads)
  Cognition's custom methods.
- **No `toolUse` re-entry loop for devin's own tools** — ACP agents run their
  tool loop server-side; `tool_call` updates are display-only. pi's
  `stopReason: "toolUse"` round-trip is only needed if we later expose pi
  tools to devin (bridge — non-goal v1).
- **One process hosts many sessions** — no per-config process fingerprint;
  model/mode are per-session config options settable mid-session, so a
  recycle is only needed on process death.

## Locked decisions

1. **Transport: `@agentclientprotocol/sdk`.** Typed schema + generic
   `onRequest`/`onNotification` overloads cover `_cognition.ai/*` custom
   methods. Stage 0 includes a smoke script; hand-rolled NDJSON
   (~350 LOC, `agy-client.ts` style) is the documented fallback if the SDK
   drops unknown notifications or fights Node's type stripper.
2. **Naming.** Provider `devin`, package `@tian.zuo/pi-devin-acp` in
   `packages/pi-devin-acp`, commands `/devin …`, state under `~/.pi/devin-acp/`.
3. **Models: family-level registration + thinking suffix.** Parse
   `devin models list` into families; register one pi model per family
   (`devin/claude-opus-5`, `devin/swe-2`, …) with contextWindow/cost from
   the family rows. Pi thinking level (`:low`/`:medium`/`:high`/`:xhigh`/
   `:max`) resolves to the concrete devin variant (`claude-opus-5-high`)
   at turn time, then `session/set_config_option {configId:"model"}` syncs
   it. `-fast`/`-priority` variants become their own selectable families
   (`devin/claude-opus-5-fast:high`). Models with no variants (plain rows)
   accept no thinking suffix. Cache at `~/.pi/devin-acp/model-list.json` with a
   bundled fallback snapshot; `session/new`'s `configOptions` is the live
   cross-check.
4. **Pi↔ACP session mapping.** Persist `{sessionId, cwd, modelId, turns}`
   per pi branch via `pi.appendEntry` (mirroring `conversation-state.ts`).
   Reload/tree-nav → `session/load` (skip when `isLocked`); `/devin reset`
   drops the mapping (never deletes the devin session); `/devin sessions`
   lists `session/list` with load/delete actions. `~/.pi/pi-acp/` already
   holds an earlier session-map attempt — read-only migration optional.
5. **History bootstrap.** First turn of a fresh ACP session receives
   serialized pi history as an embedded `resource` content block
   (`embeddedContext: true`), labeled as transcript — not a system role
   (same "text adapter" caveat as agy: devin's native system prompt is
   authoritative). Pi system prompt snapshot rides the same way on turn 1
   and on change. Stage 0 probe confirms devin reads `resource` blocks on
   `session/prompt`; fallback is labeled text.
6. **Permissions: route to pi UI.** `session/request_permission` →
   `ctx.ui.select` over ACP options (allow_once/always/reject kinds);
   abort → reject_once. Devin's mode select stays an independent coarse
   gate (`/devin mode ask|plan|code|bypass`, shown in `/devin` status —
   not mapped onto pi's permission concepts). v1 does not advertise
   fs/terminal caps.
7. **Tool display.** Display-only `devin` wrapper tool + replay store
   (pi-antigravity pattern). ACP `tool_call` already carries title/kind/
   status/locations/content — render `diff` content as an edit-style card,
   `terminal` content as output lines. No native re-execution in v1 (ACP
   results are authoritative; re-running reads buys nothing but prettier
   cards — stage later if wanted).
8. **Compaction.** Devin compacts internally (`compaction_update`); pi still
   sends its own `<conversation>` summary requests through the provider —
   run those in a **disposable ACP session** (fresh `session/new`, never
   `load`), exactly like agy's isolated runtime.

## Stages

### Stage 0 — protocol harness + smoke
**Goal**: proven transport choice and live-verified method matrix.
- `lib/acp-connection.ts`: spawn `devin acp`, NDJSON line transport via SDK
  (or hand-rolled if smoke fails); request/response map, notification fan-out,
  stderr/log routing, bounded pending-request cleanup.
- Manual probe script (not CI): initialize → session/new → prompt →
  set_config_option → cancel → session/load across a process restart →
  session/list/delete. Record results here.
**Success**: probe passes on devin 3000.10.x; custom `_cognition.ai/*`
notifications received; no leaked processes.

### Stage 1 — provider skeleton + model catalog
**Goal**: `pi --model devin/<id>` reaches a streamed answer.
- `lib/models.ts`: `devin models list` family parser → `ProviderModelConfig`
  (one pi model per family; contextWindow/cost from family rows,
  reasoning=true); thinking-level → concrete variant resolution
  (`resolveDevinModelVariant(family, level)`); cache + bundled fallback;
  `/devin models` refresh.
- `lib/diagnostics.ts` + `/devin doctor`: `devin` resolution (`DEVIN_BINARY`
  override → PATH), `devin version` parse with min-version gate (start
  3000.10.x), auth presence check, handshake probe, counters.
- `src/provider.ts`: `streamDevin` — ensure session → `session/prompt` →
  map `agent_message_chunk`/`agent_thought_chunk`/`usage_update`/
  `stopReason` to pi events; abort → `session/cancel`.
- `index.ts`: `pi.registerProvider("devin", …)`, wrapper tool, `/devin`,
  `/devin reset`, `/devin doctor`.
**Tests**: models parser, prompt conversion, event reducer vs recorded
fixtures, abort→cancel, error surfaces.

### Stage 2 — sessions, modes, config sync
**Goal**: reloads resume; model/mode pickers act on the live session.
- `lib/conversation-state.ts`: append/restore ACP session binding per pi
  branch (sessionId + cwd + model + turns), lock-aware `session/load`,
  fallback to fresh `session/new` on `session_not_found`/locked.
- Mode + model sync: pi `model_select`/`/devin mode` → `set_config_option`
  /`set_mode`; reconcile on `config_option_update`/`current_mode_update`.
- `/devin sessions` picker over `session/list` (title, age, locked);
  load/delete actions.
- Disposable-session summarization for pi compaction/branch summaries.
**Tests**: state append/restore matrix, lock/not-found fallbacks, summary
isolation (no fake user input in the real session).

### Stage 3 — tool cards + permissions
**Goal**: devin's tools render as pi cards; gated actions ask the user.
- `lib/replay.ts` + `lib/render.ts`: `tool_call`/`tool_call_update` →
  display-only `devin` cards; kind-aware labels; `diff` content → edit card;
  `terminal` content → output block; error status → error card.
- `session/request_permission` → `ctx.ui.select` (title + tool detail),
  remember allow-always per (tool-kind, path-pattern) within the turn.
- Widget hint while devin runs tools (reuse the agy widget pattern).
**Tests**: card rendering width-safety, permission option mapping, abort
during a pending permission.

### Stage 4 — polish
- `/devin login` → `authenticate` (devin-browser); auth_required error →
  actionable message.
- `_cognition.ai/agent_stopped` stats → usage/token-speed feed;
  `usage_update` → context-occupancy display.
- `available_commands_update` → `/devin commands` list (forwarding `/x`
  text prompts is cheap; decide after probing).
- Env flags: `DEVIN_BINARY`, `DEVIN_ACP_MODEL`, `PI_DEVIN_DRIVER=0`
  (rollback: fresh `devin acp` per turn), stall watchdogs like agy's.
- Changeset + README (mermaid diagram like pi-antigravity's).

## Non-goals (v1)

- Pi-tool/MCP bridge into devin (`mcpCapabilities` is stdio-only and devin
  already loads the user's own `~/.config/devin/mcp_config.json` — revisit
  only if skills-in-devin is actually wanted).
- `terminal/*` client capability (devin self-executes; a later stage could
  back it with pi's exec for background-terminals integration).
- Cognition editor extensions: documentLifecycle, userEdits, chains,
  megaplan, sessionShare UI, browser_preview, subagent_control.
- Auto-install/update of the devin binary.

## Probes still needed in Stage 0

1. `session/load` across a **process restart** (same-process load returned
   `session_not_found`; verify persisted-session resume + `isLocked`
   behavior).
2. Whether `session/prompt` `resource` blocks are actually read by the model
   (decides history bootstrap format; fallback = labeled text).
3. `session/request_permission` shape on a gated action (run a write command
   under mode `ask`/`accept-edits` and capture options payload).
4. `session/resume`/`session/fork`/`session/close` availability.
5. Whether the SDK's generic `onNotification` surfaces `_cognition.ai/*`
   methods (fallback: raw line tap).
