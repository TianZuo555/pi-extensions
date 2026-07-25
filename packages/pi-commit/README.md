# pi-tian-commit

Generate and review Git commit messages with a dedicated model without changing the model used by the current Pi session.

## Commands

- `/commit [guidance]` — generate a message for the changes already staged in Git.
- `/commit-all [guidance]` — confirm, run `git add --all`, then generate a message for the resulting staged snapshot.

Examples:

```text
/commit
/commit focus on why the retry behavior changed
/commit-all use the repository's conventional commit style
```

Both commands show the generated message in a multiline editor and ask for final confirmation before running `git commit`.

## Model setting

The extension reads `piCommit.model` from Pi's normal settings files on every invocation, so changing it does not require `/reload`.

Global setting (`~/.pi/agent/settings.json`):

```json
{
  "piCommit": {
    "model": "deepseek/deepseek-v4-flash"
  }
}
```

A trusted project can override it in `.pi/settings.json`:

```json
{
  "piCommit": {
    "model": "anthropic/claude-sonnet-4-5"
  }
}
```

The value must use `provider/model` format. Model IDs may themselves contain slashes, such as `openrouter/anthropic/claude-sonnet-4`.

When the setting is absent, the default is `deepseek/deepseek-v4-flash`. Invalid settings stop the command instead of silently sending the diff to a fallback provider. Configure authentication for the selected provider with Pi's `/login` command or `models.json`.

## Workflow and safety

- The configured model is called directly for this one task. The active session model is never switched.
- `/commit` never stages files. If the index is empty, it suggests `/commit-all`.
- `/commit-all` explicitly confirms before staging tracked, deleted, and untracked files. Git-ignored files remain ignored.
- Cancelling after `/commit-all` has staged files leaves those files staged; the extension reports this explicitly.
- The staged Git tree and `HEAD` are fingerprinted. If either changes while the message is being generated or reviewed, the commit is aborted.
- Unresolved merge conflicts are rejected.
- Normal Git hooks and signing configuration are honored. A failed commit leaves staged changes intact.
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
npm run typecheck
npm test -w pi-tian-commit
```
