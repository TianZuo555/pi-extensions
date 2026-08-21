# @tian.zuo/pi-antigravity

Use Google Antigravity (`agy`) models inside the [pi coding agent](https://pi.dev) via the agy stream-json RPC. pi stays the UI — model picker, sessions, rendering, compaction — while the Gemini agent loop runs underneath through the `agy` CLI.

**Highlights**

- Native pi tool cards for agy's tools (`grep`, `find`, `search_web`, …) with live text streaming
- **Pi-tool bridge** — agy can call pi's own extension tools (web search, subagents, repo tools) through a loopback MCP server; results execute in pi with full permission/hook/rendering ownership
- **Background-task management** — agy's long-running commands (dev servers, watchers) show up in a `/ps`-style dashboard with one-keystroke kill (`/agy-tasks`)
- Reference cost display via pi's native cost calculation, overridable per model

## How it works

- Registers an `antigravity` model provider (`pi.registerProvider`) whose `streamSimple` spawns one `agy` turn per request:

  ```
  agy --print "<prompt>" --dangerously-skip-permissions --disable-slash-commands \
      --output-format stream-json [--add-dir <cwd>] [--conversation <id>] \
      [--model <id>] [--effort low|medium|high] --print-timeout 600s
  ```

- **agy arg-order quirk:** `--print` takes the very next token as the prompt value (it is not a boolean flag). The prompt must be placed immediately after `--print`; trailing it after other flags makes the first flag string the prompt, and the model answers questions about that flag instead.
- `--dangerously-skip-permissions` is **always** passed. In agy 1.1.17 print mode this flag alone does **not** auto-approve `command(...)` permissions — un-allowlisted commands are still auto-denied headlessly and the turn fails. For autonomous operation, add an allow-rule to `~/.gemini/antigravity-cli/settings.json` (backup: `settings.json.bak-pi-antigravity`):

  ```json
  { "permissions": { "allow": ["command(*)"] } }
  ```

  agy runs fully autonomous then; pi's permission layer does not gate it.
- `--disable-slash-commands` is also always passed: without it, agy's built-in `antigravity_guide` skill hijacks headless turns — the model detours into reading its own skill docs (sometimes tripping agy's hardcoded protection boundary on `~/.gemini/`) instead of answering the prompt.
- `--add-dir <cwd>` registers the session directory as the agy workspace: agy's print mode does **not** treat the process cwd as the workspace and would otherwise fall back to `~/.gemini/antigravity-cli/scratch`.
- pi's thinking level maps to `agy --effort`: `minimal`/`low` → `low`, `medium` → `medium`, `high`/`xhigh`/`max` (and unset) → `high`. Models are registered without effort suffixes — one base model per family, effort chosen per turn.
- The NDJSON event stream (`init` / `step_update` / `result`) is parsed tolerantly and folded into pi events:
  - agy tool steps render as **native pi tool cards**, styled like pi's built-in tools:

    ```text
    grep "version" in ~/Workspace/pi-tian-extensions/packages/pi-antigravity
    ✓ 2 matches in 2 files (0.05s)

    find *.md in ~/Workspace/pi-tian-extensions/packages/pi-antigravity
    ✓ 1 result (0.02s)

    search_web "Los Angeles weather today"
    ✓ (2.39s)
    ```

    Calls show a bold native-equivalent label (`find`, `grep`, `read`, `write`, `edit`, `ls`, `bash`, …) with human-readable arguments instead of JSON; results show match/result counts where the output allows, plus a bounded output preview (full text on Ctrl+O). Pending, success, and error states get pi's standard background fills. The provider ends the assistant message at each completed tool step (`stopReason: "toolUse"`), pi executes the display-only `agy` wrapper tool (which returns the recorded agy result — no tool work runs inside pi), and the next provider request re-attaches to the still-running agy turn.
  - `agent_response` `text_delta` chunks stream live into pi's text channel. agy has no separate reasoning channel — the model writes its reasoning inline as markdown, so it streams (and renders) like normal text.
  - final `result.response` → the authoritative assistant text; `result.usage` → pi token usage; conversation continues via `--conversation <id>` across turns
- Conversation continuity: the agy conversation is reused across turns and reset when the model changes or via `/agy reset`.

## Pi-tool bridge

On `session_start` the extension hosts a loopback MCP server (streamable HTTP on `127.0.0.1`) and registers it as an agy MCP server named `pi-bridge`. Active pi extension tools are exposed as `pi__<name>` (built-ins `read/bash/write/edit/grep/find/ls` and the display-only `agy` wrapper are hidden — agy has native equivalents). When agy calls one:

1. the bridge routes the call into the live agy turn;
2. the provider ends the assistant message with a toolUse for the **real** pi tool — native card, hooks, permissions, abort all apply;
3. pi executes it; the next provider request hands the result back to the still-running agy turn over the bridge.

Calls fail closed: no active turn, unknown tool, or a 480s timeout (below agy's 600s turn cap) returns an error to agy instead of hanging.

### Skill passing

pi's loaded Agent Skills reach agy turns automatically:

- On bootstrap sends (fresh agy process), a compact catalog — name + one-liner + absolute `SKILL.md` path — is appended to the prompt. Sourced from pi's `before_agent_start` `systemPromptOptions.skills`, so `--no-skills`, `pi config`, and `/reload` are respected; skills with `disable-model-invocation` are excluded.
- With the bridge on, agy activates a skill via the bridge-virtual `pi__activate_skill` tool: it returns the full `SKILL.md` plus the absolute paths of bundled resources (relative refs are useless to agy). Handled in-process — no pi toolUse round-trip.
- With the bridge off (`PI_ANTIGRAVITY_PI_TOOL_BRIDGE=0`), the catalog instructs agy to read the `SKILL.md` paths directly — headless agy can read user-level skill dirs outside its workspace (verified 2026-08-21).

Environment flags:

- `PI_ANTIGRAVITY_PI_TOOL_BRIDGE=0` — disable the bridge entirely (no server, no registration).
- `PI_ANTIGRAVITY_EXPOSE_BUILTIN_TOOLS=1` — also expose the hidden built-in tools.

The registration lives in the global `~/.gemini/config/mcp_config.json` (agy has no per-project MCP config) and is removed on `session_shutdown`.

## Requirements

- The `agy` CLI installed and logged in (`~/.local/bin/agy`, v1.1.17+). Override the binary with `AGY_BINARY`.

## Install

```
pi install npm:@tian.zuo/pi-antigravity
pi --model antigravity/gemini-3.7-flash
```

Try from a checkout: `pi -e ./packages/pi-antigravity --model antigravity/gemini-3.7-flash`

## Commands

- `/agy` — conversation status (id, model, turns, model source)
- `/agy reset` — drop the agy conversation; the next turn starts fresh
- `/agy models` — re-discover models from `agy models` and re-register the provider
- `/agy-tasks` — open the background-task dashboard (`stop <task-id>|all` for non-interactive use)

## Managing agy background tasks

When you ask agy to run something long-lived — a dev server, a watcher, a test loop — agy turns it into a **background task**: the process keeps running on your machine while the conversation continues. pi-antigravity tracks these tasks and gives you full control without leaving pi.

### A typical session

You ask: *"start the dev server and tell me when it's up"* — agy starts it in the background and reports back:

```text
⏺ bash npm run dev
✗ bash: agy started this command as a background task, which headless agy
  cannot await ("timeout waiting for response"). The process keeps running
  after the turn — follow up in a later message to have agy check the task's
  output, or run long-lived processes with pi's own bash instead.

I have started `npm run dev`. The Vite development server is now running in
the background: http://localhost:3000/
```

The moment the turn settles, a hint appears above the editor:

```text
■ 1 agy background task • /agy-tasks to view
```

Open `/agy-tasks` any time to see and manage everything agy left running:

```text
  agy background tasks                              1 live / 2
╭─ tasks ────────────────────────────────────────────────────────╮
│ ❯ ■ [dev] $ npm start task-2             pid 47791 · running │
│   ■ (no output) task-1                    pid - · 0B · done   │
╰───────────────────────────────────────────────────────────────╯
  ↑/↓/jk select · x stop · r rescan · esc close
```

- **`x`** — stop the selected task (SIGTERM, process group included: `npm start` takes Vite down with it) and rescan
- **`r`** — rescan the conversation's task logs
- **`esc`** — close

The hint disappears when the last live task is gone. For scripts and non-interactive runs, `/agy-tasks stop <task-id>` and `/agy-tasks stop all` work without the UI.

**Closing pi stops the tasks.** On session shutdown the extension SIGTERMs any live background tasks of the current conversation, so exiting never leaves stray dev servers behind. (The agy conversation itself survives on Google's side and can be continued later.)

### How tracking works

The stream-json RPC does not report background tasks, so the extension reads them from the filesystem: each task writes a log under
`~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/tasks/`, and liveness is detected by who holds that log open (`lsof`) — or, after agy itself has exited, by finding the orphaned process (re-parented to launchd, cwd = session directory, started when the log was created).

## Notes & limits

- **Background commands:** the turn that starts one ends with "timeout waiting for response" — that is agy's protocol limit, not a bug; the card explains it and the task remains manageable via `/agy-tasks`. Follow up in a later message to have agy check the task's output, or run long-lived processes with pi's own bash instead.
- Model discovery runs `agy models` at startup (15s timeout, cached 24h in `~/.pi/antigravity/model-list.json`); a bundled fallback snapshot registers when discovery fails. Effort variants are collapsed into base models.
- **Cost display:** agy is subscription-billed on the Google side, so registered rates are reference Gemini API prices (USD per Mtok; flash tier by default, pro tier for `-pro` ids) that feed pi's native cost calculation. Override any model's rates through pi's own model config — `~/.pi/agent/models.json`:

  ```json
  {
    "providers": {
      "antigravity": {
        "modelOverrides": {
          "gemini-3.7-flash": {
            "cost": { "input": 0.3, "output": 2.5, "cacheRead": 0.075, "cacheWrite": 0.3 }
          }
        }
      }
    }
  }
  ```
- Context/output limits in the pi model list are placeholders (agy does not expose them).
- The print interface is text-only: images in the pi context are replaced by an omission note.
- pi-side compaction does not compact the agy conversation; agy keeps its own authoritative history.
- Tool cards are display-only replays: agy's DONE steps carry the duration and (for some tools) output text, never structured result payloads, so collapsed cards preview at most three lines of recorded text.
- If a globally installed older copy of this package exists (`pi list`), remove it with `pi remove npm:@tian.zuo/pi-antigravity` — its registration wins over `-e ./packages/pi-antigravity`.

## Development

```
pnpm --filter @tian.zuo/pi-antigravity run check
pnpm --filter @tian.zuo/pi-antigravity test
```
