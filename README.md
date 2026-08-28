# pi-tian-extensions

A collection of independent extensions for the [pi coding agent](https://pi.dev),
published as npm packages from a pnpm workspace monorepo.

Each extension has its own package and its own README under
[`packages/`](packages/) — this file is only an index.

## Extensions

| Package | Commands / Tools | What it does |
|---|---|---|
| [pi-repo-model](packages/pi-repo-model/README.md) | `/repo-model`, `/repo-model-unset`, `/repo-model-list` | Per-repo default model + thinking level, auto-applied at session start. |
| [pi-repo-skills](packages/pi-repo-skills/README.md) | `/skills`, `/skills-list`, `/skills-reset` | Per-repo skill toggles via checkbox TUI; disabled skills leave the prompt. |
| [pi-commit](packages/pi-commit/README.md) | `/commit`, `/commit-all` | Git commits written by a separately configured model. |
| [pi-token-speed](packages/pi-token-speed/README.md) | `/tps` | Live tok/s meter in the footer plus an end-of-message summary. |
| [pi-image-cache](packages/pi-image-cache/README.md) | `Ctrl+V`, `/images`, `/image-cache-clear` | Caches pasted images as `[Image#NNN]` and re-attaches them on send. |
| [pi-ask-user](packages/pi-ask-user/README.md) | tool `ask_user` | Lets the model ask 1–5 single-choice questions in one form. |
| [pi-usage](packages/pi-usage/README.md) | `/usage`, `/tokens` | Provider account usage (Codex, Copilot, Z.ai, DeepSeek) plus a token/cost dashboard. |
| [pi-background-terminals](packages/pi-background-terminals/README.md) | `/ps`, overrides tool `bash` | One no-stdin bash path: long commands yield to background and notify once. |
| [pi-edit-safe](packages/pi-edit-safe/README.md) | overrides tool `edit` | Stricter `edit`: verbatim splice, ambiguity throws, one `edits[]` shape. |
| [pi-find](packages/pi-find/README.md) | overrides tools `grep`/`find` | Simple, bounded regex and file-glob search. |
| [pi-subagents](packages/pi-subagents/README.md) | tool `subagent`, `/agents` | Isolated subagent runs with profiles, Herdr pane backend, and worktrees. |
| [pi-compact-output](packages/pi-compact-output/README.md) | (TUI only) | Compact tool status blocks; Ctrl+O restores full output. |
| [pi-goal](packages/pi-goal/README.md) | `/goal`, tools `get_goal`/`update_goal` | User-owned, editable objective with evidence-checked bounded continuation. |
| [pi-todo](packages/pi-todo/README.md) | tool `todo` | Small shared todo list for multi-step work. |
| [pi-web-search](packages/pi-web-search/README.md) | tools `web_search`/`web_fetch` | Clean web search & fetch via OpenAI Responses, Exa, Firecrawl, or Ollama. |
| [pi-antigravity](packages/pi-antigravity/README.md) | `/agy`, `/agy-usage` | Google Antigravity (`agy`) models inside pi via stream-json RPC. |
| [pi-vscode-bridge](packages/pi-vscode-bridge/README.md) | `/vscode-connect` | Send file/line/diff-hunk refs from VS Code into pi's editor. |

## Install

The extensions are published as independent npm packages — install only the
ones you need:

```bash
pi install npm:@tian.zuo/pi-commit
pi install npm:@tian.zuo/pi-background-terminals
```

Restart pi or run `/reload` after installation. Try an extension temporarily
without adding it to settings:

```bash
pi -e npm:@tian.zuo/pi-image-cache
```

Update installed extensions and reload:

```bash
pi update --extensions
```

Remove one independently:

```bash
pi remove npm:@tian.zuo/pi-token-speed
```

## Development

The repository is a pnpm workspace with one package per extension under
`packages/`.

```bash
pnpm install
pnpm run typecheck   # TypeScript across all workspaces
pnpm run check       # Effect checks
pnpm test            # all extension test suites
```

Try a single extension from a checkout:

```bash
pi -e ./packages/pi-repo-model
```

Extensions import pi's runtime packages (`@earendil-works/*`, `typebox`) as
**peer dependencies** — pi provides them at runtime; they are never bundled.

## Publishing

Releases use [Changesets](https://github.com/changesets/changesets). For every
publishable extension change, run `pnpm changeset`, select the package and
semantic version bump, and commit the generated release-note file. Do not bump
package versions manually.

On pushes to `main`, the [`Publish`](.github/workflows/publish.yml) workflow
runs all checks and opens or updates a release PR. Merging that PR publishes
each changed package to npm, updates its package-specific `CHANGELOG.md`, and
creates a separate tagged GitHub release. npm trusted publishing supplies OIDC
provenance without a token secret. The workflow can also be run manually from
*Actions → Publish* in dry-run mode to preview pending releases. The repository
must allow GitHub Actions to create pull requests under *Settings → Actions →
General → Workflow permissions*.

```bash
pnpm changeset          # add release notes for changed packages
pnpm changeset:status   # inspect pending releases
```

## License

[MIT](./LICENSE) © Tian Zuo
