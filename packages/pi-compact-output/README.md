# pi-tian-compact-output

TUI-only [pi coding agent](https://pi.dev) extension that keeps the transcript compact without changing tool execution, schemas, results, or session data.

## What it does

- Collapsed tool calls render as **one descriptive line** (`…` pending, `✓` success, `✗` failure).
- Press **Ctrl+O** (`app.tools.expand`) to reveal each tool's original renderer — FFF search output, read buffers, edit diffs, background-terminal views, images, and errors all return unchanged.
- Persisted reasoning blocks are hidden from the transcript. During generation, Pi's normal animated working indicator shows the label **Thinking**.

Reasoning remains in session data and model context; only the visual transcript is filtered.

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

- The extension does **not** register, replace, or proxy any tools. It patches presentation around Pi's exported `ToolExecutionComponent` and `AssistantMessageComponent` after the real tool owner has already been selected.
- Load order does not matter relative to FFF, `pi-tian-background-terminals`, or `pi-tian-edit-safe`.
- `/reload` is safe: patch installation is reference-counted and does not stack wrappers.

## License

MIT
