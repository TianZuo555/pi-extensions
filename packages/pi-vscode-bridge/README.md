# pi-vscode-bridge

Send file, line, and diff-hunk references from VS Code into a running pi agent's input editor. VS Code pushes short refs over a local unix socket; pi pastes them at the cursor without submitting. The human reviews the prefilled text and presses Enter themselves.

Install the pi extension and the VS Code companion, then attach once per session with `/vscode-connect`. After that, right-click in the Explorer or editor to send refs into pi.

## Install

```bash
pi install npm:pi-tian-vscode-bridge
pnpm --filter pi-tian-vscode-bridge run package:vscode
code --install-extension packages/pi-vscode-bridge/pi-tian-vscode-bridge-0.1.0.vsix
```

## Usage

1. Open the workspace in VS Code (the Pi VS Code Bridge extension activates on startup).
2. In a pi terminal for that repo, run `/vscode-connect`.
3. Right-click to send references:
   - **Explorer → Send to Pi** — one ref per selected file or folder, e.g. `src/foo.ts` or `lib/` (no line numbers).
   - **Editor → Send to Pi** — cursor line `src/foo.ts:42`, or a selection range `src/foo.ts:12-40`.
   - **Diff editor → Send Hunk to Pi** — the new-side hunk at the cursor, e.g. `src/foo.ts:12-40`; falls back to the editor behaviour when git/hunk lookup fails.

Each send appends refs with a trailing space so you can keep typing.

## Limitations

- **macOS and Linux only.** The transport is a unix domain socket. Windows named pipes are not implemented.
- **Local only.** Remote-SSH, devcontainers, and WSL are not supported, because the socket does not cross the remote boundary.
- Prefill never submits. The human always presses Enter.
- One agent at a time; connecting a second agent detaches the first.
