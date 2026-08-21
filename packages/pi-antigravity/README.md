# @tian.zuo/pi-antigravity

Use Google Antigravity (`agy`) models inside the [pi coding agent](https://pi.dev) via the agy stream-json RPC. pi stays the UI — model picker, sessions, rendering, compaction — while the Gemini agent loop runs underneath through the `agy` CLI.

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

## Notes & limits

- **Background commands:** agy runs long-lived commands (dev servers, watchers) as its own background tasks. In headless print mode such a step never completes — the turn ends with "timeout waiting for response" while the spawned process keeps running. The extension detects this and the card explains it; follow up in a later message to have agy check the task's output, or run long-lived processes with pi's own bash instead.
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
- Context/output limits in the pi model list are placeholders (agy does not expose them); costs are zero (subscription-billed on the Google side).
- The print interface is text-only: images in the pi context are replaced by an omission note.
- pi-side compaction does not compact the agy conversation; agy keeps its own authoritative history.
- Tool cards are display-only replays: agy's DONE steps carry the duration and (for some tools) output text, never structured result payloads, so collapsed cards preview at most three lines of recorded text.
- If a globally installed older copy of this package exists (`pi list`), remove it with `pi remove npm:@tian.zuo/pi-antigravity` — its registration wins over `-e ./packages/pi-antigravity`.

## Development

```
pnpm --filter @tian.zuo/pi-antigravity run check
pnpm --filter @tian.zuo/pi-antigravity test
```
