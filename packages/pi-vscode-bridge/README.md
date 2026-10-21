# pi-vscode-bridge (deprecated)

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-vscode-bridge/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

> **Deprecated:** no longer recommended or actively developed. The source
> remains here for historical reference; deprecation does not introduce a
> replacement extension. The root package no longer loads this extension, and
> it is no longer built, tested, or packaged in CI.

## Remove it

```bash
pi remove npm:@tian.zuo/pi-vscode-bridge
code --uninstall-extension tianzuo.pi-vscode-bridge
```

Restart Pi or run `/reload` to unload it. Remove any explicit local extension
paths and instructions requiring the `/vscode-connect` command from your own
settings, prompts, or `AGENTS.md`.

## Historical behavior

Send file, line, and diff-hunk references from VS Code into a running pi agent's input editor. VS Code pushes short refs over a local unix socket; pi pastes them at the cursor without submitting. The human reviews the prefilled text and presses Enter themselves.

Install the pi extension and the VS Code companion, then attach once per session with `/vscode-connect`. After that, right-click in the Explorer or editor to send refs into pi.

## Historical install

The published package is no longer built or published. These are the steps that
applied while it was maintained:

```bash
pi install npm:@tian.zuo/pi-vscode-bridge
pnpm --filter @tian.zuo/pi-vscode-bridge run package:vscode
code --install-extension packages/pi-vscode-bridge/vscode/pi-vscode-bridge-0.1.0.vsix
```

## Historical usage

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
