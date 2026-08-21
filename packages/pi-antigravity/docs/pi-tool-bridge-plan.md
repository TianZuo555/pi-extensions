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
- **Settings are global.** No per-run MCP flag exists in `agy --help` and no
  per-project config is honored (verified 2026-08-21, see open question 4).
  Registrations live in `~/.gemini/config/mcp_config.json`
  (`{"mcpServers": {…}}`) — **not** `antigravity-cli/settings.json`, which
  only holds `permissions.allow` etc. We already manage those permission
  rules for headless runs.
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
  pass `--dangerously-skip-permissions`; **verified 2026-08-21** that stdio
  MCP calls are covered — no allow rule was needed for the echo probe (see
  open question 1 for the full verification). Re-confirm when the bridge
  lands; if a rule is ever needed, add an allow rule to `settings.json`
  alongside the existing `permissions.allow` handling.
- **Timeouts:** agy turn timeout is 600s; long-running pi tools (background
  terminals) may outlive it. Decide: cap bridge tool timeout, or stream a
  "still running" placeholder. cursor-sdk raises MCP tool timeout to 3600s.
- **Re-attach ambiguity:** `beginStreamTurn` matches on same prompt; bridged
  turns must be distinguishable from user retries (pending-call map keyed by
  call id should disambiguate).
- **Schema bloat:** only expose a bounded set of tools; consider a
  `pi__mcp`-style meta-tool if the registry is large.

### Phase 2 — Skills via the bridge

**Status: implemented (0.3.0, with per-skill tools).** agy's native
skill expansion is disabled by `--disable-slash-commands`, so it is done
bridge-first. Each bridged global skill is exposed as its own
`pi__<skill_name>` tool (description = the skill's one-liner; calling it
returns the SKILL.md bundle), replacing the earlier single
`pi__activate_skill` design.

**Skill discovery overlap (verified 2026-08-21 via probes in a scratch
workspace):** agy natively scans `<workspace>/.agents/skills/` (walking up
from its cwd to the repo root) plus `~/.gemini/config/skills/` and built-ins,
and injects those skills' names/descriptions EVEN under
`--disable-slash-commands` — and the model can then self-activate by reading
the SKILL.md (probe: headless turn answered a planted codeword after reading
the file). It does NOT scan `~/.agents/skills` or `~/.pi/agent/skills`.
Therefore: workspace-project skills are deduped out of our injected catalog
(`nonWorkspaceSkills`); the bridge catalog covers pi-only global skills,
which agy would never see otherwise.

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

1. ~~**AGENTS.md dedup:**~~ ~~first verify whether agy print mode loads project
   `AGENTS.md`~~ **Dropped — see open question 2.** agy does load it, but pi
   injects the same file, so content is identical by construction; dedup
   would add complexity for no behavioral gain.
2. Auto-manage the bridge permission allow-rule in `settings.json`.
3. Callable-surfaces manifest block in the prompt (list current `pi__*`
   names, prefer-bridge guidance).
4. Card rendering for bridged calls should be indistinguishable from native
   pi tool cards (they already will be — they *are* native pi tool calls).

## Open questions (verify before coding Phase 1)

1. ~~Does agy headless actually **invoke** MCP tools under
   `--dangerously-skip-permissions`, and do MCP calls appear as normal
   `tool` steps in the stream (so existing cards render them)?~~ **Yes —
   verified 2026-08-21** (agy 1.1.17): registered a trivial stdio echo MCP
   server via `agy mcp add demo-echo -- node /tmp/echo-mcp.mjs`; headless
   print mode listed its tools, invoked `echo` autonomously (no permission
   prompt), and returned the server's exact output (`ECHO:hello-from-pi`,
   status SUCCESS). The call appeared as a normal `tool` step
   (`call_mcp_tool`, ACTIVE→DONE with `output`) — existing card rendering
   applies unchanged.
2. ~~Does agy print mode load project `AGENTS.md`?~~ **Yes — verified
   2026-08-21** (agy 1.1.17): planted a workspace `AGENTS.md` with a random
   codeword; headless print mode answered the codeword with **zero tool
   steps** (no file reads) — it was loaded into context automatically.
   **Decision:** no dedup work. Pi consumes the same project-root
   `AGENTS.md` and injects it as `<project_instructions>`, so agy sees the
   identical content twice — redundant but consistent, and both harnesses
   stay in sync by construction. Phase 3.1 (stripping overlapping blocks,
   cursor-sdk style) is dropped unless real-world token bloat or conflicts
   from nested/parent-dir AGENTS.md files ever warrant revisiting.
3. ~~Does the bridge server need to be reachable at agy spawn time only, or
   per call?~~ **At spawn time — verified 2026-08-21.** agy eagerly spawns
   stdio MCP servers at process startup and immediately sends
   `tools/list`, even when the turn never calls a tool (one spawn per agy
   run, confirmed via spawn-log timestamps). A dead stdio command or an
   unreachable HTTP URL does not abort startup: the turn proceeds, but any
   `call_mcp_tool` against it errors and the turn ends `status: ERROR`
   ("server … failed to load" / "tool … is not enabled for server").
   Consequences for the bridge:
   - start the loopback server **before** spawning agy; lazy start is not
     viable;
   - servers do not outlive the agy process, so `session_shutdown` disable/
     remove is sufficient cleanup — no orphaned bridge processes;
   - bridge downtime = failed antigravity turns (fail closed), which makes
     the rollback flag and careful port/lifecycle handling mandatory.
4. ~~Is there per-project MCP configuration?~~ **No — verified 2026-08-21.**
   A workspace-local `.gemini/settings.json` with an `mcpServers` block is
   ignored by `agy mcp list`; `agy mcp add` has no scope flag; the
   `projects/default-cli-project.json` store carries no MCP resources.
   Decision: accept writing global state — register one well-known
   `pi-bridge` entry in `~/.gemini/config/mcp_config.json` and remove it on
   `session_shutdown`. Keep permission rules in `antigravity-cli/settings.json`
   as today (separate file, separate concern).
5. ~~How does agy name MCP tools in `tool_info`?~~ **Verified 2026-08-21:**
   it is the generic built-in `call_mcp_tool` (not `mcp__server__tool`),
   with the target in `step_update.step_info.parameters`:
   `{ServerName: "demo-echo", ToolName: "echo", Arguments: {…}}` and the
   result in `.output`. Card rendering should display `ToolName` (with
   `ServerName` as context); pending-call correlation keys off
   `ServerName` + `ToolName` + `Arguments`. Same mechanism serves
   `pi__activate_skill` in Phase 2.
6. ~~Can headless agy read files under `~/.pi/agent/skills/` (outside the
   `--add-dir <cwd>` workspace) without permission prompts?~~ **Yes —
   verified 2026-08-21** via probe script (`bash /tmp/agy-skill-probe.sh`,
   run through Herdr): agy 1.1.17 print mode with
   `--dangerously-skip-permissions --disable-slash-commands --add-dir <cwd>`
   read `~/.pi/agent/skills/herdr/SKILL.md` and echoed its frontmatter name.
   Phase 2's no-bridge fallback is viable.
