# pi-tian-vscode-review

A small bridge between [pi](https://pi.dev) and a VS Code review panel.

`/vscode-review` captures the current tracked worktree diff, opens a local
review panel in VS Code, and sends line-addressed feedback back to the active
Pi session.

## Install the Pi extension

From this repository while developing:

```bash
pi -e ./packages/pi-vscode-review
```

After publishing:

```bash
pi install npm:pi-tian-vscode-review
```

## Install the VS Code extension

Build the VS Code host:

```bash
npm run compile:vscode -w pi-tian-vscode-review
```

The VS Code CLI installs a **VSIX**, not a source directory. Package the
extension, then install the generated VSIX:

```bash
npm run package:vscode -w pi-tian-vscode-review
code --install-extension packages/pi-vscode-review/pi-tian-vscode-review-0.1.0.vsix
```

If the version changes, use the matching generated filename.

The installed VS Code extension ID is `tianzuo.pi-tian-vscode-review` because
VS Code derives the ID from `publisher.name`. Do not install
`tianzuo.pi-vscode-review` by ID; install the generated `.vsix` file instead.

Restart VS Code after installation. With both sides active, run this in Pi:

```text
/vscode-review
```

## Review protocol

The Pi side starts a one-shot loopback HTTP server and opens this URI:

```text
vscode://tianzuo.pi-tian-vscode-review/start?reviewId=...&port=...&token=...
```

The VS Code side fetches the patch, renders it in a Webview, and submits
annotations such as:

```json
{
  "filePath": "src/app.ts",
  "lineStart": 42,
  "lineEnd": 48,
  "side": "new",
  "text": "Move validation before the database call."
}
```

The bridge converts those annotations into a user message in Pi. No review
content leaves the machine unless the Pi model provider sends the resulting
message to its configured provider.

## Current MVP scope

- Current tracked changes from `git diff HEAD`.
- Added/deleted line selection and whole-hunk selection.
- Comments and optional suggested code.
- Approve, send feedback, and cancel.
- One review at a time, protected by a random local token.

Untracked-file support, staged/unstaged comparison selection, and richer
suggestion application can be added after the basic flow is validated.
