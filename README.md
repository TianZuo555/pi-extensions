# pi-tian-extensions

A small collection of [pi coding agent](https://pi.dev) extensions.

| Extension | Commands / Tools | What it does |
|---|---|---|
| **pi-repo-model** | `/repo-model`, `/repo-model-unset`, `/repo-model-list` | Per-repo default model + thinking level, auto-applied at session start. |
| **pi-repo-skills** | `/skills`, `/skills-list`, `/skills-reset` | Per-repo skill toggles via checkbox TUI; disabled skills leave the prompt. |
| **pi-commit** | `/commit`, `/commit-all` | Git commits written by a separately configured model. |
| **token-speed** | `/tps` | Live tok/s meter in the footer plus an end-of-message summary. |
| **image-cache** | `Ctrl+V`, `/images`, `/image-cache-clear` | Caches pasted images as `[Image#NNN]` and re-attaches them on send. |
| **ask-user** | tool `ask_user` | Lets the model ask 1–5 single- or multi-select questions in one form. |
| **usage** | `/usage` | Codex and Copilot account usage in a menu, plus a footer meter. |
| **background-terminals** | `/ps`, overrides tool `bash` | One no-stdin bash path: long commands yield to background and notify once. |
| **edit-safe** | overrides tool `edit` | Stricter `edit`: verbatim splice, ambiguity throws, one `edits[]` shape. |
| **subagents** | tool `subagent`, `/agents` | Isolated RPC child processes with profiles, background runs, and worktrees. |
| **compact-output** | (TUI only) | Shows bordered tool status blocks with up to three preview lines; Ctrl+O restores full output; reasoning stays compact. |
| **goal** | `/goal`, tools `get_goal`/`create_goal`/`update_goal` | Codex-style persistent, evidence-checked objective with bounded automatic continuation. |
| **vscode-bridge** | `/vscode-connect` | Attaches a VS Code window so right-click "Send to Pi" prefills file, line, and diff-hunk references into Pi's editor. |

Each extension is described in detail under [Extensions](#extensions).

Selections for the per-repo extensions are stored centrally and keyed by git
root, so each repository keeps its own preferences without touching global
settings or the repo's own `.pi/` folder.

## Install

The extensions are published as independent npm packages, so you can
install all of them or only the ones you need.

### Install all

```bash
pi install npm:pi-tian-repo-model
pi install npm:pi-tian-repo-skills
pi install npm:pi-tian-commit
pi install npm:pi-tian-token-speed
pi install npm:pi-tian-image-cache
pi install npm:pi-tian-ask-user
pi install npm:pi-tian-usage
pi install npm:pi-tian-background-terminals
pi install npm:pi-tian-edit-safe
pi install npm:pi-tian-subagents
pi install npm:pi-tian-compact-output
pi install npm:pi-tian-goal
```

Restart pi or run `/reload` in an existing session after installation.

The commands above add these entries to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:pi-tian-repo-model",
    "npm:pi-tian-repo-skills",
    "npm:pi-tian-commit",
    "npm:pi-tian-token-speed",
    "npm:pi-tian-image-cache",
    "npm:pi-tian-ask-user",
    "npm:pi-tian-usage",
    "npm:pi-tian-background-terminals",
    "npm:pi-tian-edit-safe",
    "npm:pi-tian-subagents",
    "npm:pi-tian-compact-output",
    "npm:pi-tian-goal"
  ]
}
```

### Install individual extensions

| Extension | Install command |
|-----------|-----------------|
| [pi-tian-repo-model](https://www.npmjs.com/package/pi-tian-repo-model) | `pi install npm:pi-tian-repo-model` |
| [pi-tian-repo-skills](https://www.npmjs.com/package/pi-tian-repo-skills) | `pi install npm:pi-tian-repo-skills` |
| [pi-tian-commit](https://www.npmjs.com/package/pi-tian-commit) | `pi install npm:pi-tian-commit` |
| [pi-tian-token-speed](https://www.npmjs.com/package/pi-tian-token-speed) | `pi install npm:pi-tian-token-speed` |
| [pi-tian-image-cache](https://www.npmjs.com/package/pi-tian-image-cache) | `pi install npm:pi-tian-image-cache` |
| [pi-tian-ask-user](https://www.npmjs.com/package/pi-tian-ask-user) | `pi install npm:pi-tian-ask-user` |
| [pi-tian-usage](https://www.npmjs.com/package/pi-tian-usage) | `pi install npm:pi-tian-usage` |
| [pi-tian-background-terminals](https://www.npmjs.com/package/pi-tian-background-terminals) | `pi install npm:pi-tian-background-terminals` |
| [pi-tian-edit-safe](https://www.npmjs.com/package/pi-tian-edit-safe) | `pi install npm:pi-tian-edit-safe` |
| [pi-tian-subagents](https://www.npmjs.com/package/pi-tian-subagents) | `pi install npm:pi-tian-subagents` |
| [pi-tian-compact-output](https://www.npmjs.com/package/pi-tian-compact-output) | `pi install npm:pi-tian-compact-output` |
| [pi-tian-goal](https://www.npmjs.com/package/pi-tian-goal) | `pi install npm:pi-tian-goal` |
| [pi-tian-vscode-bridge](https://www.npmjs.com/package/pi-tian-vscode-bridge) | `pi install npm:pi-tian-vscode-bridge` |

Try an extension temporarily without adding it to settings:

```bash
pi -e npm:pi-tian-image-cache
```

### Migrate from a Git install

Do not load the Git package and its npm replacements together; that would load
the same extension twice. Check your current packages first:

```bash
pi list
```

Remove any old package shown by `pi list`, then install the npm packages you
want:

```bash
# Old aggregate package, if installed:
pi remove git:github.com/TianZuo555/pi-tian-extensions

# Old standalone token-speed package, if installed:
pi remove git:github.com/TianZuo555/pi-token-speed

pi install npm:pi-tian-repo-model
pi install npm:pi-tian-repo-skills
pi install npm:pi-tian-commit
pi install npm:pi-tian-token-speed
pi install npm:pi-tian-image-cache
pi install npm:pi-tian-ask-user
pi install npm:pi-tian-usage
pi install npm:pi-tian-background-terminals
```

Your existing extension preferences and caches remain in `~/.pi/`; changing the
package source does not remove them.

### Update installed extensions

Update every installed Pi package and reload the current session:

```bash
pi update --extensions
```

Then restart pi or run `/reload`. To update only one package:

```bash
pi update npm:pi-tian-repo-model
```

Remove an extension independently with, for example:

```bash
pi remove npm:pi-tian-token-speed
```

### Legacy aggregate Git install

The repository root remains an aggregate package for backward compatibility:

```bash
pi install git:github.com/TianZuo555/pi-tian-extensions
```

New installations should prefer the individual npm packages above.

## Extensions

### pi-repo-model

Stores one model preference per repository in `~/.pi/repo-model/config.json` and
applies it at session start (default triggers: fresh start + new session). An explicit `pi --model ...` takes precedence on startup.

- `/repo-model` — pick a model, then a thinking level, from dropdowns.
- `/repo-model provider/model[:thinking]` — set directly, e.g. `/repo-model cursor/composer-2.5:high`.
- `/repo-model-unset` — clear the current repo's default.
- `/repo-model-list` — list every configured repo.

### pi-repo-skills

Turns individual skills on/off per repository. Disabled skills are removed from
the system prompt (like `disable-model-invocation: true`), so the model won't
auto-load them. State lives in `~/.pi/repo-skills/config.json`.

- `/skills` — checkbox TUI: `↑↓/jk` move, `space` toggle, `a` disable all,
  `n` enable all, `enter` save, `esc` cancel.
- `/skills-list` — list all repos with overrides.
- `/skills-reset` — clear this repo's overrides.

`disabled` is stored as an array of skill names or the sentinel `"ALL"` (every
skill off, future-proof against newly installed skills).

### pi-commit

Generates commit messages with a dedicated model without changing the active Pi
session model. The default is `deepseek/deepseek-v4-flash`; override it globally
in `~/.pi/agent/settings.json` or, for a trusted project, in `.pi/settings.json`:

```json
{
  "piCommit": {
    "model": "deepseek/deepseek-v4-flash",
    "thinkingLevel": "high"
  }
}
```

For example, to use GPT-5.6 Luna with maximum reasoning:

```json
{
  "piCommit": {
    "model": "openai-codex/gpt-5.6-luna",
    "thinkingLevel": "max"
  }
}
```

- `/commit [guidance]` — generate, edit, and confirm a commit for changes already staged in Git.
- `/commit-all [guidance]` — confirm `git add --all`, then generate, edit, and confirm the commit.

`/commit` never stages files. `/commit-all` includes tracked, deleted, and
untracked files but not ignored files. Cancelling after its staging step leaves
those changes staged. The extension fingerprints both the staged tree and
`HEAD`, honors normal Git hooks/signing, and aborts if the snapshot changes
while the message is being reviewed. Staged paths containing `node_modules` are
rejected before their contents are sent to the model or committed. The prompt
also warns against dependency trees and generated artifacts. The staged diff is
sent to the configured model provider; patch context is capped at 256 KiB.

### token-speed

A live generation-speed readout. While the assistant streams, the footer shows a
smoothed tokens-per-second rate; when the message finishes it shows a summary
with the average rate, total output tokens, and time-to-first-token. The summary
stays on screen after the stream stops — including the model's between-stream
thinking and tool-call gaps — so the readout is always visible instead of
blanking out whenever generation pauses.

- `/tps` — cycle the display mode: `live` → `final` → `off`.
- `/tps live` — live meter + summary.
- `/tps final` — summary only.
- `/tps off` — show nothing.

The live rate is sampled from streamed text (a responsive chars-per-token
estimate); the end-of-message average uses the provider's authoritative output
token count when available. The mode is remembered in
`~/.pi/token-speed/config.json`.

### image-cache

Caches pasted images so they survive as compact `[Image#NNN]` placeholders and
are re-attached to the model on send. On macOS, `Ctrl+V` pastes the clipboard
image directly — both raw image data (screenshots, "Copy Image") and image
files copied in Finder, including multiple files at once. File references win
over pasteboard image data, because Finder also puts a generic 1024×1024
document icon on the clipboard next to the file it copied. Cache lives under
`~/.pi/agent/cache/image-cache/` with a 24h TTL, alongside a small PNG
rendition per non-PNG image so inline previews work in Kitty-protocol
terminals (Ghostty, Kitty, WezTerm) and after a session resume.

### ask-user

Registers an `ask_user` tool the model can call with 1–5 questions and 2–5
options per question. Full questions and option descriptions word-wrap instead
of being clipped. Each question supports single selection by default or
multiple selections with `allow_multiple: true`; a free-form **Other** option is
always appended.

- `←` / `→` switches questions while preserving answers.
- `↑` / `↓` moves the focused option; `Space` selects or toggles it.
- `Enter` advances to the next question or submits after all questions are
  answered; `Esc` dismisses.
- Other opens an inline multi-line editor. RPC mode uses built-in dialogs;
  print/json mode reports that no UI was available.
- Tool calls stored by versions through 0.1.2 with top-level `question` and
  `options` are upgraded automatically to the new `questions[]` schema.

The result lists every answer with its question and option number (or marks it
as custom text), so the model never silently assumes an answer.

### usage

Shows current-account usage for **OpenAI Codex** and **GitHub Copilot** without
leaving pi.

- `/usage` — open a menu listing both providers' usage (limits, remaining
  percentage, absolute quota, and reset time). Pick **Refresh** to re-query or
  **Close** to dismiss. In non-interactive modes it prints a one-line summary.
- When the active model belongs to a supported provider, a compact meter such
  as `codex 60% wk` or `copilot 49% premium` is published to the footer and
  refreshed at most every five minutes (results are cached).

Credentials come from the same store pi writes (`~/.pi/agent/auth.json`): Codex
uses the ChatGPT OAuth access token; Copilot uses the stored GitHub OAuth token
(with `GH_TOKEN` / `GITHUB_TOKEN` and `~/.config/github-copilot/apps.json` as
fallbacks). `/usage` skips the usage request for each provider with no login
information and shows it as **Not configured** — sign in with `/login` and select
it.

### background-terminals

Replaces the built-in `bash` tool with one no-stdin execution path. Quick
commands return normally; a command that outlives the initial wait keeps running
as a session-scoped background terminal and its result is delivered to the model
exactly once, so there is nothing to poll. Quick Bash rows show their useful
command and a bounded output preview; only commands that actually yield collapse
to compact terminal rows. Complete human-facing stdout/stderr remains in `/ps`.

- Parameters: `command`, plus optional `timeout` (hard kill), `working_dir`,
  `title`, and `yield_time_ms` (default 10s, clamped to 250–30,000 ms).
- `/ps` — full-screen viewer: list every tracked terminal, then inspect its
  default **Info** tab or switch to stdout/stderr, tail live output, and stop a
  running terminal with `x`.
- Once a stream outgrows in-memory retention, the viewer pages the **complete
  on-disk log** instead of only what fits in memory.
- A one-line widget renders above the editor while any terminal is running.
- Every call uses a fresh shell; prompt guidance directs the model to
  `working_dir` rather than persistent `cd` assumptions. Read-only Bash
  exploration warns at 6 calls and blocks after 8 within one agent run.

Inspection and termination are user-owned — the model gets no status, list,
kill, or stdin tools. See
[packages/pi-background-terminals/README.md](packages/pi-background-terminals/README.md)
for the full design.

### edit-safe

Overrides the built-in `edit` tool with a stricter matcher. Fuzzy matching only
**locates** a target span; the replacement is always spliced in verbatim, never
re-indented or rewritten.

- **Ambiguity throws.** Occurrences are counted overlap-aware (`aa` in `aaa` is
  ambiguous, not unique), and a strategy matching more than one candidate fails
  instead of falling through to a looser matcher or picking a "best" candidate.
- **No partial-signal matching.** No first/last-line anchoring and no similarity
  thresholds — every fuzzy candidate must be a full-span structural match that
  occurs exactly once.
- **Untouched bytes stay untouched.** BOMs and bytes outside the matched span
  survive, and mixed-line-ending files are never flattened.
- **Lenient input, strict schema.** The model is offered exactly **one** call
  shape — `{path, edits: [...]}`, always an array, even for a single change — so
  there is no per-call choice to get wrong. Looser shapes
  (`file_path`/`old_string` aliases, a stringified `edits` array, a bare edit
  object, top-level `oldText`/`newText`) are still folded onto that form before
  validation, so off-contract or older resumed calls are normalized rather than
  rejected.
- **Sequential multi-edit.** `edits[]` applies in order, each matched against the
  already-updated text, so dependent edits work; a later failure leaves the file
  unchanged because the write happens once at the end.

Returns pi's built-in `EditToolDetails` (`diff`, `patch`, `firstChangedLine`) and
defines no custom renderers, so pi's streaming diff preview and final diff
rendering are inherited.

Disable without uninstalling: `PI_EDIT_SAFE_DISABLE=1 pi`.

See [packages/pi-edit-safe](packages/pi-edit-safe/README.md) for the full
matching order and the A/B bench against pi's real built-in edit.

### compact-output

TUI-only presentation extension for Pi **0.83.x**. It does not register or
override any tools.

- Consecutive collapsed tool calls share one padded, background-filled area;
  each row starts with `🔧` and the newest row appears first.
- Press **Ctrl+O** (`app.tools.expand`) to toggle tool rows and assistant reasoning
  between compact and each original renderer in execution order — FFF search output,
  read buffers, edit diffs, background-terminal views, images, errors, and full
  reasoning text return unchanged.
- While working, the animated loader shows `Thinking: <one-line reasoning preview>`;
  the transcript also keeps reasoning to one concise line until Ctrl+O expands it.

```bash
pi install npm:pi-tian-compact-output
pi -e ./packages/pi-compact-output
```

### vscode-bridge

Attaches a VS Code window to a running pi agent so right-click **Send to Pi** prefills file, line, and diff-hunk references into the input editor. The human reviews the text and presses Enter themselves.

Install both sides:

```bash
pi install npm:pi-tian-vscode-bridge
npm run package:vscode -w pi-tian-vscode-bridge
code --install-extension packages/pi-vscode-bridge/pi-tian-vscode-bridge-0.1.0.vsix
```

Run `/vscode-connect` in Pi. See [packages/pi-vscode-bridge](packages/pi-vscode-bridge/README.md)
for setup, ref formats, and limitations.

### goal

Codex-style long-running goals for Pi. `/goal <objective>` persists a
thread-scoped completion contract, injects it into each turn, accounts token and
elapsed-time usage, and continues only while the thread is idle. A continuation
that makes no tool call suppresses the next automatic continuation, so this is
not an unbounded loop.

```bash
pi install npm:pi-tian-goal
pi -e ./packages/pi-goal
```

Use `/goal pause`, `/goal resume`, `/goal clear`, or `/goal --budget 50000
<objective>` to manage it. See [packages/pi-goal](packages/pi-goal/README.md)
for the full lifecycle and Codex design mapping.

The repository is an npm workspace with one publishable package per extension:

| Workspace | npm package |
|-----------|-------------|
| `packages/pi-repo-model` | `pi-tian-repo-model` |
| `packages/pi-repo-skills` | `pi-tian-repo-skills` |
| `packages/pi-commit` | `pi-tian-commit` |
| `packages/pi-token-speed` | `pi-tian-token-speed` |
| `packages/pi-image-cache` | `pi-tian-image-cache` |
| `packages/pi-ask-user` | `pi-tian-ask-user` |
| `packages/pi-usage` | `pi-tian-usage` |
| `packages/pi-background-terminals` | `pi-tian-background-terminals` |
| `packages/pi-edit-safe` | `pi-tian-edit-safe` |
| `packages/pi-subagents` | `pi-tian-subagents` |
| `packages/pi-compact-output` | `pi-tian-compact-output` |
| `packages/pi-goal` | `pi-tian-goal` |
| `packages/pi-vscode-bridge` | `pi-tian-vscode-bridge` |

Install dependencies, typecheck every workspace, run the commit and
managed-terminal suites, and inspect publishable tarballs:

```bash
npm install
npm run typecheck
npm run check -w pi-tian-background-terminals
npm test -w pi-tian-background-terminals
npm test -w pi-tian-commit
npm test -w pi-tian-edit-safe
npm test -w pi-tian-subagents
npm test -w pi-tian-compact-output
npm test -w pi-tian-goal
npm run pack:check
```

Test a workspace directly:

```bash
pi -e ./packages/pi-repo-model
```

The files under `extensions/` are compatibility entry points for the aggregate
Git package. Implementations live in `packages/` so each npm tarball is
self-contained.

Extensions import pi's runtime packages
(`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai`, `typebox`) as **peer dependencies** — pi provides them
at runtime.

## Publishing

### Automated (GitHub Actions)

The [`Publish`](.github/workflows/publish.yml) workflow publishes packages to npm
automatically. On every push to `main` that touches `packages/**`, it runs both
TypeScript checks plus the extension test suites, including goal and
background-terminals, then
checks each workspace's version against npm and publishes only versions not yet present
(so bumping one `package.json` version is enough to release it). Packages are
published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).

Requirements:

- Add an `NPM_TOKEN` repository secret (an npm **Automation** access token with
  publish rights) under *Settings → Secrets and variables → Actions*.
- The workflow can also be triggered manually via *Actions → Publish → Run
  workflow*, with an optional **dry-run** toggle that runs `npm publish
  --dry-run` without releasing.

### Manual

After logging in to npm, publish each workspace independently:

```bash
npm publish --workspace packages/pi-repo-model
npm publish --workspace packages/pi-repo-skills
npm publish --workspace packages/pi-commit
npm publish --workspace packages/pi-token-speed
npm publish --workspace packages/pi-image-cache
npm publish --workspace packages/pi-ask-user
npm publish --workspace packages/pi-usage
npm publish --workspace packages/pi-background-terminals
npm publish --workspace packages/pi-goal
npm publish --workspace packages/pi-vscode-bridge
```

Version and publish only the package that changed, or bump them all together for
a coordinated release.

## License

[MIT](./LICENSE) © Tian Zuo
