# pi-tian-compact-output

TUI-only [pi coding agent](https://pi.dev) extension that keeps the transcript compact without changing tool execution, schemas, results, or session data.

## What it does

- Consecutive collapsed tool calls share one padded, background-filled area that shows a single line: the last tool's call and a `· +N more` count. FFF-style outputs (read buffers, ffgrep/fffind) get the same one-line treatment, and the full output of every tool returns on expand.
- Press **Ctrl+O** (`app.tools.expand`) to reveal each tool's original renderer and the complete reasoning text in execution order — FFF search output, read buffers, edit diffs, background-terminal views, images, and errors all return unchanged.
- While working, the animated loader shows `Thinking: <one-line reasoning preview>`, and the transcript keeps reasoning to one concise line. Ctrl+O restores the complete reasoning text.

## Requirements

- Pi **0.83.x** (`@earendil-works/pi-coding-agent >=0.83.0 <0.84.0`). On other versions the extension installs safely but leaves Pi's default rendering in place and shows one warning in TUI mode.

## Install

```bash
pi install npm:pi-tian-compact-output
```

Try without installing:

```bash
pi -e ./packages/pi-compact-output
```

## Behavior notes

- The extension does **not** register, replace, or proxy any tools. It patches presentation around Pi's exported `ToolExecutionComponent` and `AssistantMessageComponent` after the real tool owner has already been selected. Pi's existing Ctrl+O action also expands the assistant reasoning view.
- Load order does not matter relative to FFF, `pi-tian-background-terminals`, or `pi-tian-edit-safe`.
- `/reload` is safe: patch installation is reference-counted and does not stack wrappers.

## License

MIT
