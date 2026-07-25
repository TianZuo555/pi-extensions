# pi-tian-extensions

A small collection of [pi coding agent](https://pi.dev) extensions.

| Extension | Commands / Tools | What it does |
|-----------|------------------|--------------|
| **pi-repo-model** | `/repo-model`, `/repo-model-unset`, `/repo-model-list`, tool `repo_default_model` | Remembers a default model + thinking level **per repository** and auto-applies it at session start. |
| **pi-repo-skills** | `/skills`, `/skills-list`, `/skills-reset`, tool `repo_skills` | Enable/disable individual skills **per repository** via a checkbox TUI. Disabled skills are stripped from the system prompt. |
| **pi-commit** | `/commit`, `/commit-all` | Generate, edit, and confirm Git commits with a separately configured model; defaults to DeepSeek V4 Flash. |
| **token-speed** | `/tps` | Live tokens-per-second meter in the footer while the assistant streams, plus an end-of-message summary (avg tok/s, total tokens, time-to-first-token). |
| **image-cache** | `Ctrl+V`, `/images`, `/image-cache-clear` | Caches pasted/clipboard images as `[Image#NNN]` placeholders and attaches them to your messages (macOS clipboard support). |
| **ask-user** | tool `ask_user` | Lets the model ask you a single multiple-choice question (2–5 options plus a free-form "write my own answer") in a popup. |
| **usage** | `/usage` | Show **OpenAI Codex** and **GitHub Copilot** account usage in a menu, plus a compact footer meter for the active provider. |
| **background-terminals** | `/ps`, overrides tool `bash` | Replace Pi's built-in Bash with one no-stdin execution path: quick commands return normally, long commands automatically continue in the background and notify the model exactly once. `/ps` provides live inspection and user-owned termination. |

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
    "npm:pi-tian-background-terminals"
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
applies it at session start (default triggers: fresh start + new session).

- `/repo-model` — pick a model, then a thinking level, from dropdowns.
- `/repo-model provider/model[:thinking]` — set directly, e.g. `/repo-model cursor/composer-2.5:high`.
- `/repo-model-unset` — clear the current repo's default.
- `/repo-model-list` — list every configured repo.

The agent can also manage it via the `repo_default_model` tool.

### pi-repo-skills

Turns individual skills on/off per repository. Disabled skills are removed from
the system prompt (like `disable-model-invocation: true`), so the model won't
auto-load them. State lives in `~/.pi/repo-skills/config.json`.

- `/skills` — checkbox TUI: `↑↓/jk` move, `space` toggle, `a` disable all, `n` enable all, `enter` save, `esc` cancel.
- `/skills-list` — list all repos with overrides.
- `/skills-reset` — clear this repo's overrides.
- Tool `repo_skills` — `get` / `list` / `disable` / `enable` / `disable-all` / `enable-all` / `reset`.

`disabled` is stored as an array of skill names or the sentinel `"ALL"` (every
skill off, future-proof against newly installed skills).

### pi-commit

Generates commit messages with a dedicated model without changing the active Pi
session model. The default is `deepseek/deepseek-v4-flash`; override it globally
in `~/.pi/agent/settings.json` or, for a trusted project, in `.pi/settings.json`:

```json
{
  "piCommit": {
    "model": "deepseek/deepseek-v4-flash"
  }
}
```

- `/commit [guidance]` — generate, edit, and confirm a commit for changes already staged in Git.
- `/commit-all [guidance]` — confirm `git add --all`, then generate, edit, and confirm the commit.

`/commit` never stages files. `/commit-all` includes tracked, deleted, and
untracked files but not ignored files. Cancelling after its staging step leaves
those changes staged. The extension fingerprints both the staged tree and
`HEAD`, honors normal Git hooks/signing, and aborts if the snapshot changes
while the message is being reviewed. The staged diff is sent to the configured
model provider; patch context is capped at 256 KiB.

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
image directly. Cache lives under `~/.pi/agent/cache/image-cache/` with a 24h TTL.

### ask-user

Registers an `ask_user` tool the model can call to ask you a single
multiple-choice question. The model supplies the question and 2–5 options; a
free-form **"Write my own answer"** option is always appended, and you can
dismiss the question without answering.

- Interactive mode shows a popup: `↑↓` or number keys `1-N` to move, `Enter` to
  confirm, `Esc` to dismiss.
- "Write my own answer" opens a multi-line editor; submitting an empty answer
  returns to the option list.
- RPC mode falls back to the built-in select/input dialogs; print/json mode
  reports that no UI was available so the model asks in plain text instead.

The tool result tells the model exactly what happened — which option (by number)
was picked, the free-form text you wrote, or that you dismissed the question —
so it never silently assumes an answer.

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
fallbacks). A provider with no resolvable credential shows as **Not configured**
— sign in with `/login` and select it.

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

Install dependencies, typecheck every workspace, run the commit and
managed-terminal suites, and inspect publishable tarballs:

```bash
npm install
npm run typecheck
npm run check -w pi-tian-background-terminals
npm test -w pi-tian-background-terminals
npm test -w pi-tian-commit
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
TypeScript checks plus the commit and background-terminals test suites, then
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
```

Version and publish only the package that changed, or bump them all together for
a coordinated release.

## License

[MIT](./LICENSE) © Tian Zuo
