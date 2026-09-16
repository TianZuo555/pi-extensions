# @tian.zuo/pi-devin-acp

Use [Devin](https://devin.ai) models inside [pi](https://pi.dev) by driving the
Devin CLI as an ACP (Agent Client Protocol) server.

```bash
pi -e ./extensions/pi-devin-acp.ts --model devin/swe-2
```

Devin runs its own agent loop server-side — this extension keeps that loop
intact and surfaces it in pi: streamed text and thinking, tool cards, usage,
permissions, modes, and persistent sessions.

## Requirements

- `devin` CLI ≥ `3000.10.0` on `PATH` (or `DEVIN_BINARY=/path/to/devin`)
- Authenticated once via `devin auth login` (or `WINDSURF_API_KEY`)

## Models

Run `devin models list` to see the catalog. The extension registers one pi
model per Devin model family/variant and resolves pi's thinking suffix to a
concrete Devin row:

| pi model                       | resolves to (examples)            |
| ------------------------------ | --------------------------------- |
| `devin/adaptive`               | Devin's auto model selection      |
| `devin/swe-2`                  | `swe-2-medium` (default)          |
| `devin/swe-2:max`              | `swe-2-max`                       |
| `devin/claude-opus-5:high`     | `claude-opus-5-high`              |
| `devin/claude-opus-5-fast:low` | `claude-opus-5-low-fast`          |
| `devin/gpt-5.4:off`            | `gpt-5-4-none`                    |
| `devin/gpt-5.4-fast:high`      | `gpt-5-4-high-priority`           |
| `devin/claude-sonnet-4.6:high` | `claude-sonnet-4-6-thinking`      |

Requested thinking levels resolve to the highest available Devin variant at or
below that level (e.g. `:xhigh` on a family without xhigh picks `high`).

Model discovery runs `devin models list`, caches the parsed catalog in
`~/.pi/devin-acp/models.json`, and falls back to a bundled snapshot when the CLI is
unavailable.

## Commands

- `/devin` — current session, model, mode, and turn stats
- `/devin reset` — drop the Devin session binding (next turn starts fresh)
- `/devin sessions` — list Devin sessions; attach or delete one
- `/devin-tasks` — list Devin operations still in flight (slow execs,
  detached background shells) in a /ps-style overlay: `enter` opens a
  read-only detail view (invocation info + live streamed output with tabs and
  scrolling), `x` asks Devin to stop a background shell
- `/devin-usage` — session usage reported over ACP: context-window bar,
  cumulative tokens/cost (credits/ACUs when billed), and last-turn stats —
  rendered `/usage`-style with Devin's own response-dimension grouping
- `/devin mode [ask|plan|accept-edits|bypass]` — get/set Devin's permission mode
- `/devin yolo [on|off]` — persistently pin Devin to `bypass` mode
  (`~/.pi/devin-acp/settings.json`); while on, `/devin mode` stays bypass and
  any permission request that still arrives is auto-approved
- `/devin models` — re-discover models and re-register the picker
- `/devin login` — trigger Devin's browser authentication
- `/devin doctor` — binary, auth, catalog, and runtime diagnostics
- `/devin-<sub>` — the hyphenated aliases (`/devin-sessions`, `/devin-reset`,
  `/devin-models`, `/devin-mode`, `/devin-yolo`,
  `/devin-login`, `/devin-doctor`) run the matching `/devin <sub>` command
  inline
- `/devin-<name>` — run Devin's own slash commands and skills-as-commands
  (e.g. `/devin-compact`). Only exists while a Devin model is selected;
  forwards `/<name> args` into the ACP session
- `/compact` under a Devin model runs *Devin's* compaction instead — every pi
  trigger (manual `/compact [instructions]`, the context threshold, overflow
  recovery) is vetoed (`session_before_compact`) and forwarded into the ACP
  session; auto-triggered forwards are rate-limited. `/skill:<name>` under a
  Devin model runs Devin's same-named skill-command; pi's own skill never
  expands.

## How it works

- One `devin acp` child process (stdio NDJSON/JSON-RPC) hosts ACP sessions.
- Each pi session branch binds to one Devin session id; the binding persists in
  pi's session file (`pi-devin-acp-session-state` entries) so reloading pi resumes
  the same Devin session via `session/load`.
- Streamed `session/update` notifications become pi thinking/text blocks,
  tool-card placeholders, and usage.
- Devin tool calls appear as display-only `devin` tool calls; pi "executes"
  them by replaying the recorded Devin result, then re-enters the provider.
- `session/request_permission` prompts through pi's select UI and reports
  `agent:input_required` (plus the legacy `herdr:blocked` alias) on pi's event
  bus while it waits, so integrations such as Herdr can flag the session as
  blocked. Headless runs deny by default; set
  `PI_DEVIN_HEADLESS_PERMISSION=allow` to auto-allow.
- Pi-side compaction is vetoed for Devin models (`session_before_compact`)
  and routed to Devin's own `/compact` — Devin compacts its context
  server-side. Branch-summary prompts still run in disposable ACP sessions,
  synced to the selected model, so they never pollute the real Devin
  session's history.
- Switching between Devin models keeps the live session — the new model is
  applied via `session/set_config_option`. Switching to or from another
  provider re-bootstraps the next turn from pi's transcript.
- A message that arrives while a Devin turn is still running (steering text, a
  `/devin-tasks` shell stop) becomes the next prompt in the same session: the
  ACP channel takes one prompt at a time, so the in-flight turn is cancelled
  and the new prompt is issued once Devin acknowledges the cancel.
- Long-running Devin operations (foreground `sleep`-style execs, shells
  detached to the background via `_meta["cognition.ai/background"]`) are
  tracked as live ops: a status-bar widget shows `devin: N running — …` while
  any are in flight, and `/devin-tasks` lists them. A backgrounded shell that
  outlives its turn replays as a neutral note (with its shell id) instead of
  a failure card; it drops off the list when its `terminal_exit` arrives.
  Closing the runtime (`/new`, `/quit`, `/reload`) kills detached background
  shells together with the `devin acp` child — their process groups are
  signalled before the child dies, so nothing is orphaned.

## Environment variables

| Variable                        | Purpose                                       |
| ------------------------------- | --------------------------------------------- |
| `DEVIN_BINARY`                  | Path to the devin binary (default: PATH)      |
| `PI_DEVIN_DEBUG=1`              | Log devin-acp stderr lines to pi's stderr     |
| `PI_DEVIN_HEADLESS_PERMISSION`  | `allow` auto-approves prompts without a UI    |
| `DEVIN_MODEL`                   | Devin-side default model for new sessions     |

## Notes and limits

- Devin ACP does not implement `session/resume`, `session/fork`, or
  `session/close` — the extension uses `session/load`/`session/new` only.
- Empty Devin sessions are not persisted server-side; the binding falls back to
  `session/new` if a stored session is gone.
- MCP servers cannot be attached through ACP (`mcpCapabilities` accepts stdio
  only, unused here); Devin's own MCP config applies.
- Devin's slash commands and skills-as-commands arrive via
  `available_commands_update` (counted in `/devin` status); `/devin-<name>`
  is intercepted and forwards `/<name> args` to Devin, which runs it
  server-side.
- `before_provider_request` fires for devin turns with the ACP prompt request
  (`{ sessionId, prompt }`); returning an object with a replacement `prompt`
  swaps the outgoing content blocks. `after_provider_response` never fires:
  it reports an HTTP status and headers, and ACP over stdio has neither.

## Development

```bash
pnpm run check   # typecheck (tsc --noEmit)
pnpm test        # unit tests + a live ACP round-trip (skipped without devin)
```
