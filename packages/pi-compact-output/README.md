# pi-tian-compact-output

TUI-only [pi coding agent](https://pi.dev) extension that keeps the transcript compact without changing tool execution, schemas, results, or session data.

## What it does

- Consecutive collapsed tool calls share one padded, background-filled area that shows up to three lines: the last tool's call summary plus the first lines of its result output — e.g. a grep shows `grep /pattern/ in path` followed by two match lines. Groups show a `· +N more` count. FFF-style outputs (read buffers, ffgrep/fffind) get the same compact treatment, and the full output of every tool returns on expand.
- Press **Ctrl+O** (`app.tools.expand`) to reveal each tool's original renderer and the complete reasoning text in execution order — FFF search output, read buffers, edit diffs, background-terminal views, images, and errors all return unchanged.
- Reasoning blocks stay in transcript order and use the same padded block style as tools. Pi's built-in thinking label/markdown is hidden; only the compact blocks show while collapsed. Ctrl+O expands those blocks in place.
- While working, the footer keeps pi's default `Working...` spinner — the floating line is left untouched and never mirrors reasoning content (previews live in the transcript, not the footer). Codex commentary text that duplicates thinking stays hidden.

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
