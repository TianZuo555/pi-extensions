# @tian.zuo/pi-antigravity

Use Google Antigravity (`agy`) models inside the [pi coding agent](https://pi.dev) via the agy stream-json RPC. pi stays the UI — model picker, sessions, rendering, compaction — while the Gemini agent loop runs underneath through the `agy` CLI.

## How it works

- Registers an `antigravity` model provider (`pi.registerProvider`) whose `streamSimple` spawns one `agy` turn per request:

  ```
  agy --print "<prompt>" --dangerously-skip-permissions --disable-slash-commands \
      --output-format stream-json [--conversation <id>] [--model <id>] \
      --print-timeout 600s
  ```

- **agy arg-order quirk:** `--print` takes the very next token as the prompt value (it is not a boolean flag). The prompt must be placed immediately after `--print`; trailing it after other flags makes the first flag string the prompt, and the model answers questions about that flag instead.
- `--dangerously-skip-permissions` is **always** passed. In agy 1.1.17 print mode this flag alone does **not** auto-approve `command(...)` permissions — un-allowlisted commands are still auto-denied headlessly and the turn fails. For autonomous operation, add an allow-rule to `~/.gemini/antigravity-cli/settings.json` (backup: `settings.json.bak-pi-antigravity`):

  ```json
  { "permissions": { "allow": ["command(*)"] } }
  ```

  agy runs fully autonomous then; pi's permission layer does not gate it.
- `--disable-slash-commands` is also always passed: without it, agy's built-in `antigravity_guide` skill hijacks headless turns — the model detours into reading its own skill docs (sometimes tripping agy's hardcoded protection boundary on `~/.gemini/`) instead of answering the prompt.
- The NDJSON event stream (`init` / `step_update` / `result`) is parsed tolerantly and folded into pi events:
  - live tool activity → pi thinking channel (dim, collapsible)
  - final `result.response` → the assistant text (agy emits no text deltas)
  - `result.usage` → pi token usage; conversation continues via `--conversation <id>` across turns
- Conversation continuity: the agy conversation is reused across turns and reset when the model changes or via `/agy reset`.

## Requirements

- The `agy` CLI installed and logged in (`~/.local/bin/agy`, v1.1.17+). Override the binary with `AGY_BINARY`.

## Install

```
pi install npm:@tian.zuo/pi-antigravity
pi --model antigravity/gemini-3.7-flash-high
```

Try from a checkout: `pi -e ./packages/pi-antigravity --model antigravity/gemini-3.7-flash-high`

## Commands

- `/agy` — conversation status (id, model, turns, model source)
- `/agy reset` — drop the agy conversation; the next turn starts fresh
- `/agy models` — re-discover models from `agy models` and re-register the provider

## Notes & limits

- Model discovery runs `agy models` at startup (15s timeout, cached 24h in `~/.pi/antigravity/model-list.json`); a bundled fallback snapshot registers when discovery fails.
- Context/output limits in the pi model list are placeholders (agy does not expose them); costs are zero (subscription-billed on the Google side).
- The print interface is text-only: images in the pi context are replaced by an omission note.
- pi-side compaction does not compact the agy conversation; agy keeps its own authoritative history.

## Development

```
pnpm --filter @tian.zuo/pi-antigravity run check
pnpm --filter @tian.zuo/pi-antigravity test
```
