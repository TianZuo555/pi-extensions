# pi-tian-commit

Generate and review Git commit messages with a dedicated model without changing the model used by the current Pi session.

## Commands

- `/commit [guidance]` — generate a message for the changes already staged in Git.
- `/commit-all [guidance]` — confirm, run `git add --all`, then generate a logical commit plan for the resulting staged snapshot.

Examples:

```text
/commit
/commit focus on why the retry behavior changed
/commit-all use the repository's conventional commit style
```

Both commands let you review the generated message(s) in multiline editors, then ask how to finish: **Commit and push**, **Commit only**, or **Cancel**.

- `/commit` reviews and creates one commit.
- `/commit-all` asks the model for a logical commit plan, grouping whole files into separate commits for independent features or logic changes. Every generated message is reviewed in one editor; use **↑/↓** to switch between commits, **←/→** to move the text cursor, and **Enter** to advance or finish.
- **Commit and push** creates all planned commits, then pushes the current branch once. Separate loading indicators remain visible while commits and the push are running. Press **Esc** while pushing to stop the push; the local commit(s) are kept. If the branch has no upstream, the push sets it (`--set-upstream`) on the default remote — `origin`, or the only configured remote when `origin` is absent.
- **Commit only** creates all planned commits with loading indicators and stops there.
- **Cancel** (or dismissing any prompt) leaves everything staged; for `/commit-all` the staged files stay staged.

## Model setting

The extension reads `piCommit.model` and the optional `piCommit.thinkingLevel` from Pi's normal settings files on every invocation, so changing them does not require `/reload`.

Global setting (`~/.pi/agent/settings.json`):

```json
{
  "piCommit": {
    "model": "deepseek/deepseek-v4-flash",
    "fallbackModel": "openai-codex/gpt-5.6-luna",
    "thinkingLevel": "high",
    "fallbackThinkingLevel": "low"
  }
}
```

A trusted project can override any value in `.pi/settings.json`:

```json
{
  "piCommit": {
    "model": "openai-codex/gpt-5.6-luna",
    "fallbackModel": "deepseek/deepseek-v4-flash",
    "thinkingLevel": "max"
  }
}
```

The model value must use `provider/model` format. Model IDs may themselves contain slashes, such as `openrouter/anthropic/claude-sonnet-4`.

`thinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. The selected model's supported levels are respected; omit it to use the provider default. When the model setting is absent, the default is `deepseek/deepseek-v4-flash`. Invalid settings stop the command instead of silently changing the configured model.

Optional `fallbackModel` uses the same `provider/model` format. When the primary model cannot be resolved or authenticated, or when generation with the primary model fails, the extension retries with the fallback and shows a warning. `fallbackThinkingLevel` overrides the thinking level for the fallback model; when omitted, the primary `thinkingLevel` is reused. Configure authentication for each provider with Pi's `/login` command or `models.json`.

## Workflow and safety

- The configured model is called directly for this one task. The active session model is never switched.
- `/commit` never stages files. If the index is empty, it suggests `/commit-all`.
- `/commit-all` explicitly confirms before staging tracked, deleted, and untracked files. Git-ignored files remain ignored.
- `/commit-all` groups at whole-file granularity; different hunks in the same file stay in the same planned commit.
- Staged paths containing `node_modules` are rejected before their contents are sent to the model or committed, including force-staged/tracked dependency files.
- The prompt also warns against dependency trees, package-manager caches, build/coverage output, and editor/system artifacts.
- Cancelling after `/commit-all` has staged files leaves those files staged; the extension reports this explicitly.
- The staged Git tree and `HEAD` are fingerprinted. If either changes while the message is being generated or reviewed, the commit is aborted.
- Unresolved merge conflicts are rejected.
- Normal Git hooks and signing configuration are honored. A failed commit leaves staged changes intact.
- When pushing, all planned commits are created before the push runs. If the push fails (no network, missing credentials, rejected remote, etc.), the local commits are kept and the error is reported; you can retry the push yourself.
- The staged patch, file list, diff stat, optional guidance, and recent commit subjects are sent to the configured model provider. Review staged content for secrets before invoking the command.
- Model patch context is capped at 256 KiB. For larger changes, the full file list and stat are retained and the UI warns that patch content was truncated.

## Install

```bash
pi install npm:pi-tian-commit
```

Restart Pi or run `/reload` after installation.

Try the local workspace without installing it:

```bash
pi -e ./packages/pi-commit
```

## Development

From the repository root:

```bash
pnpm run typecheck
pnpm --filter pi-tian-commit test
```
