# @tian.zuo/pi-compact-output

TUI-only [pi coding agent](https://pi.dev) extension that keeps the transcript compact without changing tool execution, schemas, results, or session data.

## What it does

- Consecutive collapsed tool calls share one bordered status block with the status sign in the top-left label: pending calls use the loading sign, successful calls use `✓` with the theme's success border, and failed calls use `✗` with the theme's error border. The block shows up to three preview lines: the last tool's call summary plus the first lines of its result output — e.g. a grep shows `grep /pattern/ in path` followed by two match lines. Groups place the `· +N more` count on a separate line after the preview limit. FFF-style outputs (read buffers, ffgrep/fffind) get the same compact treatment, and the full output of every tool returns on expand.
- Press **Ctrl+O** (`app.tools.expand`) to reveal each tool's original renderer and the complete reasoning text in execution order — FFF search output, read buffers, edit diffs, background-terminal views, images, and errors all return unchanged.
- Reasoning blocks stay in transcript order as **bordered boxes with a `Reasoning` label** in the top-left corner; their borders use the theme's main text color for stronger contrast. While the current reasoning section is active, an animated loading sign spins next to the label at a deliberately readable cadence and becomes a themed `✓` when that section finishes. Provider-generated bold wrappers such as `**Reasoning**` are removed from the display copy, long lines wrap to the terminal width, and explicit paragraph breaks remain visible when expanded. Inside, plain italic text shows the latest five streamed lines while collapsed (auto-scroll to the bottom — the newest reasoning is always visible). Pi's built-in thinking label/markdown is hidden; only the compact blocks show while collapsed. Ctrl+O expands those blocks in place to the full thinking text.
- While working, the footer keeps pi's default `Working...` spinner — the floating line is left untouched and never mirrors reasoning content (previews live in the transcript, not the footer). Codex commentary text that duplicates thinking stays hidden.

## Requirements

- Pi **0.83.x** (`@earendil-works/pi-coding-agent >=0.83.0 <0.84.0`). On other versions the extension installs safely but leaves Pi's default rendering in place and shows one warning in TUI mode.

## Install

```bash
pi install npm:@tian.zuo/pi-compact-output
```

Try without installing:

```bash
pi -e ./packages/pi-compact-output
```

## Behavior notes

- Maximum collapsed lines are configurable in settings.json (project `.pi/settings.json` overrides the global one when the project is trusted):

```json
{
  "compactOutput": {
    "toolLines": 3,
    "reasoningLines": 5
  }
}
```

  Both default to the values above and are clamped to 1–12.

- The extension does **not** register, replace, or proxy any tools. It patches presentation around Pi's exported `ToolExecutionComponent` and `AssistantMessageComponent` after the real tool owner has already been selected. Pi's existing Ctrl+O action also expands the assistant reasoning view.
- Load order does not matter relative to FFF, `@tian.zuo/pi-background-terminals`, or `@tian.zuo/pi-edit-safe`.
- `/reload` is safe: patch installation is reference-counted and does not stack wrappers.

## License

MIT
