# @tian.zuo/pi-beautify-style

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-beautify-style/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

A Claude Code-style TUI for the [pi coding agent](https://pi.dev): tool cards,
rich diffs, a status footer, and `/context`. It also knows about this
repository's `ask_user`, background-terminal, and usage extensions.

This package is a maintained fork of
[minuque/pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) (MIT).
See [ATTRIBUTION.md](./ATTRIBUTION.md). Install **one or the other**, not both.

## Install

```bash
pi install npm:@tian.zuo/pi-beautify-style
```

If `pi-cc-extensions` is installed, remove it first — both extensions patch the
same `ToolExecutionComponent` and would fight over every tool card:

```bash
pi remove npm:pi-cc-extensions
```

Try from a checkout without installing:

```bash
pi -e ./packages/pi-beautify-style
```

## What it does

- **Tool cards** in three modes — `on`, `compact`, `off` — with collapsed
  summaries, click-to-expand, and a spinner plus elapsed time while a tool runs.
- **Rich diffs** for `edit` and `write`, with split/unified layout, Shiki
  highlighting, and configurable collapse limits.
- **Compact mode**: one summary line per assistant message, with per-round tool
  counts.
- **Footer** in three fixed rows: builtin statistics (model, context, cache,
  rate, cost), then location (cwd, session name, git), then every other
  extension's `setStatus` chip, including `pi-usage` and the MCP count. Plugin
  chips never crowd the first two rows.
- **`/context`** to inspect context usage and preview the system prompt, memory,
  skills, and tool definitions.
- **`@` references** to pull context from an earlier session or a running
  subagent.
- **Fullscreen extras**: click-to-expand cards, hover highlighting, sticky user
  message, and a back-to-bottom button (`--tui-mode fullscreen`).

## Integration with this repo

The fork adapts upstream's renderers to the sibling packages:

| Package | What changes |
| --- | --- |
| `@tian.zuo/pi-ask-user` | The `ask_user` card uses the same answer tree as upstream's `ask_user_question`, including `choice: { label, wasCustom }` answers, the question-count suffix, and custom ("Other") text. |
| `@tian.zuo/pi-background-terminals` | Its `bash` and `terminal_wait`/`terminal_stop`/`terminal_log_read` tools use the same beautify card as every other tool: a live elapsed timer, and the terminal id in the title of the `terminal_*` cards. |
| `@tian.zuo/pi-usage` | The footer treats `setStatus("usage")` as the usage chip on row 3. Upstream only recognized `pi-usage`/`localUsage`, so this package's chip used to stay empty. |

`@tian.zuo/pi-token-speed` needs no integration either: its
`setStatus("token-speed")` text fills the footer's built-in rate chip instead of
adding a second one.

`@tian.zuo/pi-compact-output` is superseded by this package — its compact tool
blocks and reasoning boxes are what this package renders. Do not run both.

## Configuration

There is none. This package ships no `/ccstyle` command, no settings panel, and
no JSON file. Every knob — render mode, diff layout, footer chips, reasoning
window height — is a source constant in
[`extensions/config/config.ts`](./extensions/config/config.ts). Edit that file
and restart Pi to change behavior.

> [!TIP]
> In fullscreen mode, click `click to show more` to expand a tool card, a
> reasoning block, or a compact summary. Expanded cards show the full diff;
> Input/Output past their line limit open a full preview.
>
> Reasoning streams in a five-row window and hides completely once the run
> ends (`Thought for 8s · ctrl+t to expand`). Press `ctrl+t` to open every
> finished reasoning block; press it again to hide them.

> [!NOTE]
> For Mermaid diagrams, set `markdown.mermaid` to `final` in
> `~/.pi/agent/settings.json`. The default `streaming` mode repaints on every
> frame and is less stable.

## Compatibility

- Node.js `>=22.19.0`, Pi `^1.2.0`.
- Patches `ToolExecutionComponent`, `AssistantMessageComponent`, and
  `Container.addChild`. If a future Pi drops one of them, the extension installs
  without patching and Pi's native rendering stays in place.

## Development

```bash
pnpm install
pnpm --filter @tian.zuo/pi-beautify-style test
```

Tests under `test/` come from upstream and run unmodified except where the fork
intentionally changes behavior (see the `usage` key assertions in
`test/footer.test.ts`). Two upstream tests are not carried over because they
load extension modules through `jiti`, which this repo does not depend on.

## Attribution

- Rendering stack and most of `extensions/`: `minuque/pi-cc-extensions`
  (MIT).
- Rich diff renderer: `MasuRii/pi-tool-display` (MIT).

Full text in [ATTRIBUTION.md](./ATTRIBUTION.md).

## License

[MIT](./LICENSE) © Tian Zuo, and the upstream authors listed above.
