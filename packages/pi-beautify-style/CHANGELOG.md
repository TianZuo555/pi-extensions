# @tian.zuo/pi-beautify-style

## 0.2.0

### Minor Changes

- [#176](https://github.com/TianZuo555/pi-extensions/pull/176) [`69f9f0e`](https://github.com/TianZuo555/pi-extensions/commit/69f9f0eba56e00d7b29ca28d6f757da5018ac542) Thanks [@TianZuo555](https://github.com/TianZuo555)! - First published release.
  
  `@tian.zuo/pi-beautify-style` replaces `@tian.zuo/pi-compact-output` with a vendored Claude Code-style TUI: tool cards, rich diffs, a status footer, `/context`, `@session` and `@subagent` references, and integrations for this repository's `ask_user`, background-terminal, and usage extensions.
  
  The rendering stack comes from `minuque/pi-cc-extensions` (MIT, see `ATTRIBUTION.md`), so this repository owns it. Install this package instead of `npm:pi-cc-extensions` — both patch `ToolExecutionComponent` and must not run together.
  
  There is no runtime configuration. Render mode, diff layout, footer chips, and the reasoning preview length are source constants in `extensions/config/config.ts`. The package ships no theme files; every color comes from the active Pi theme.

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Remove runtime configuration.
  
  The package no longer has a settings surface. Gone:
  
  - the `/ccstyle` command (`on` / `compact` / `off` / `status` / `panel`)
  - the six-tab settings panel (`extensions/config/panel.ts`)
  - `~/.pi/agent/pi-beautify-style.json`, including the migration from
    `pi-cc-extensions.json` and `claude-code-style.json`
  
  Every knob — render mode, diff layout, footer chips, reasoning preview length,
  `@` reference features — is now a source constant in
  `extensions/config/config.ts`. Edit that file and restart Pi to change
  behavior. Any existing `pi-beautify-style.json` is ignored and can be deleted.
  
  Render mode is fixed to `"on"` (Claude Code tool cards with rich diffs).

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Remove the custom startup header.
  
  The package no longer paints its own banner over Pi's built-in header, and the `showStartupHeader` option is gone from the config file, the `/ccstyle panel`, and `/ccstyle status`. Any local `showStartupHeader` value is ignored on load.
  
  This frees the `ctx.ui.setHeader()` slot for whichever extension the user actually wants there — this repo's `welcome` extension, for example — instead of competing with it.

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Remove the bundled `cc-dark` and `cc-light` themes.
  
  The package now renders entirely through the active Pi theme. Every color —
  tool cards, diffs, reasoning, footer chips — comes from the theme's slots
  (`toolSuccessBg`, `toolErrorBg`, `dim`, `accent`, …), so whichever theme you run
  applies as-is.
  
  `package.json` no longer declares `pi.themes` or ships a `themes/` directory.
  If you selected `cc-dark` or `cc-light` from this package, switch to another
  theme; those two names will not resolve after upgrading.

### Patch Changes

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Address three review findings.
  
  **Narrow terminals.** The footer prepended its editor-alignment indent before clamping the payload, so a width smaller than the indent still emitted at least one payload column plus the full indent — `render(1)` produced three columns. `indentFooterLine` now clamps the indent to the width first and gives the payload whatever remains, down to zero.
  
  **Prompt separation.** The `@session:[...]` header, including the instruction that referenced sessions are untrusted context, was inlined in `extensions/feature/reference/session.ts`. It moved to `lib/prompt.ts` as `SESSION_REFERENCE_HEADER`, next to the subagent delegation text, so all model-facing wording lives in one auditable place.
  
  **Main-screen patch cleanup.** `installMainScreenDoRenderPatch` patched `TuiMainScreen.prototype.applyLineResets` but returned nothing, so unloading the extension left the stale-scrollback behavior active until the process restarted. It now returns an ownership-guarded disposer, called from `session_shutdown`, that restores the original method only when the slot still holds this installation.

- [#177](https://github.com/TianZuo555/pi-extensions/pull/177) [`33fd5ae`](https://github.com/TianZuo555/pi-extensions/commit/33fd5ae9fea337ca9e2d8c44d271b5ec9a7fdc9a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Clip the long session and branch names in the footer.
  
  `footerLabelClip` (default 16) limits the session name and the branch name. A longer name keeps its head and ends with `…`, so `fix/beautify-style-review` shows as `fix/beautify-sty…`. The change stats after the branch name do not move. Set it to `0` to show the full names.

- [#177](https://github.com/TianZuo555/pi-extensions/pull/177) [`33fd5ae`](https://github.com/TianZuo555/pi-extensions/commit/33fd5ae9fea337ca9e2d8c44d271b5ec9a7fdc9a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Lay the footer out in three fixed rows so plugin chips never crowd the location
  line.
  
  Row 1 keeps the builtin statistics (model, context, cache, rate, cost). Row 2
  keeps the location (cwd, session name, branch) plus the MCP server count, which
  this package draws itself. Row 3 collects every other extension's `setStatus()`
  text, including `pi-usage`.
  
  Before this change, plugin chips were appended to row 2 next to the cwd and
  branch, and any `usage`/`quota`/`balance` key went to row 1. The footer grew
  sideways as extensions registered status text. Now the first two rows stay
  stable and row 3 is the only one that flexes. Row 3 stays hidden while no plugin
  publishes text, so the footer still shrinks to two rows when quiet.
  
  Remove the line-assignment helpers (`moveFooterKeyToLine`, `shiftFooterKeyLine`,
  `reorderFooterKey`, `toggleFooterKeyHidden`, `resolveFooterChipLayout`,
  `normalizeFooterChipLayout`, `defaultFooterLine`) and the `footerLine1Keys` /
  `footerLine2Keys` / `footerLine3Keys` config fields. They existed for a settings
  panel this package no longer has, and the rows are no longer user-assigned.
  `footerHiddenKeys` stays: it still hides a plugin chip on row 3.
  
  The MCP chip no longer enters the plugin channel. It is location information,
  so it sits on row 2 next to the branch, and a third-party `mcp` status still
  suppresses the builtin one to avoid a duplicate chip.

- [#177](https://github.com/TianZuo555/pi-extensions/pull/177) [`33fd5ae`](https://github.com/TianZuo555/pi-extensions/commit/33fd5ae9fea337ca9e2d8c44d271b5ec9a7fdc9a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Stream reasoning in a five-row window, hide it when the run ends, and open it
  with `ctrl+t`.
  
  While a thinking run streams, the card shows at most `liveThinkingLines`
  (default `5`) rows. Newer reasoning pushes older rows up out of the window, so
  the block stays a stable height instead of growing down the transcript.
  
  When the run finishes (text or a tool call follows), the body is hidden
  completely. Only one row remains: `Thought for 8s · ctrl+t to expand`, or
  `Thought for 8s · click to show more` in fullscreen.
  
  `ctrl+t` (`app.thinking.toggle`) expands every finished thinking card to its
  full text and keeps new cards expanded, the same way Pi's own toggle works.
  Press it again to hide the bodies. Clicking one card while the toggle is on
  collapses only that card. Selector and dialog screens keep their own `ctrl+t`
  (for example the `/tree` filter).
  
  `previewLines` is renamed to `liveThinkingLines` because it now sizes the live
  window, not a finished preview. This package also always owns the reasoning
  block now; Pi's own renderer used to stay in place whenever `hideThinkingBlock`
  was off, which made the setting silently inert.

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Restore the docked-bash prototype patch when an interactive session shuts down, and keep headless sessions from installing it. Clear disposed main-screen patch registry entries even when another extension wraps the method.

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Render reasoning text with the theme's `thinkingText` slot instead of `dim`.
  
  `thinkingText` is Pi's dedicated "Thinking block text color" — Pi's own thinking renderer uses it — so reasoning now follows whatever the active theme sets for it. The `Thought for 6s` heading and the `N more lines` hint stay on `dim`, which keeps them reading as metadata rather than content.

- [#177](https://github.com/TianZuo555/pi-extensions/pull/177) [`33fd5ae`](https://github.com/TianZuo555/pi-extensions/commit/33fd5ae9fea337ca9e2d8c44d271b5ec9a7fdc9a) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Fix review findings.
  
  - Every tool uses the beautify card, including the `bash` and `terminal_*` tools from `@tian.zuo/pi-background-terminals`. Only `Agent` keeps its own renderer.
  - A settled tool title no longer gets wider than the terminal when it renders again. On a narrow terminal the extra width made Pi stop with "Rendered line exceeds terminal width".
  - The `write` override is installed only in TUI sessions. Print and headless sessions keep the `write` tool that is already registered.
  - Session shutdown always removes this installation's patches, and the next session installs them again. A newer installation's sticky-prompt patches are no longer removed by an older shutdown.
  - `setStatus("token-speed")` from `@tian.zuo/pi-token-speed` fills the footer rate chip instead of adding a second rate chip.
  - `setStatus("usage")` from `@tian.zuo/pi-usage` fills the usage chip and is shown once.
  - The `@subagent:[name]` delegation instruction is sent only when an `Agent` tool exists. An unreadable entry in `~/.pi/agent/agents` is skipped instead of failing the handler.
  - Syntax highlighting does not try again on every repaint for a language that failed.
  - The `/clear` and `/exit` aliases are removed.
  - The unused `lib/our-tools.ts` helpers and their exports are removed.

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Tighten the git and rate chips.
  
  The git chip dropped its parentheses: `(+12 −4)` is now ` +12/−4`, which reads as one token instead of a nested group. The rate chip replaced the `avg` prefix with the same md-flash glyph the rest of the footer uses, so `avg 211 tok/s` is now `󰉁 211 tok/s`. `live` keeps its word, since that mode has to stay distinguishable from the average.
