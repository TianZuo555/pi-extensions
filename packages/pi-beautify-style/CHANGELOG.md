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

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Add `@tian.zuo/pi-beautify-style`, a Claude Code-style TUI for pi, replacing `@tian.zuo/pi-compact-output`.
  
  The rendering stack — tool cards, rich diffs, compact mode, the footer, `/context`, `@` session/subagent references, fullscreen mouse interaction, and the bundled `cc-dark`/`cc-light` themes — is vendored from `minuque/pi-cc-extensions` (MIT) so this repository owns it. Install it instead of `npm:pi-cc-extensions`; both patch `ToolExecutionComponent` and must not run together.
  
  This repo's extensions are wired in:
  
  - `ask_user` renders through the upstream answer-tree card, including `choice: { label, wasCustom }` answers and the question-count suffix.
  - `terminal_wait`, `terminal_stop`, and `terminal_log_read` render as shell-style cards with a live elapsed timer and the terminal id in the title.
  - The footer treats `setStatus("usage")` as the usage chip, so `@tian.zuo/pi-usage` no longer renders an empty slot.
  
  Settings moved to `~/.pi/agent/pi-beautify-style.json`; existing `pi-cc-extensions.json` and `claude-code-style.json` files are migrated on first load.

### Patch Changes

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Let `@tian.zuo/pi-background-terminals` render its own tool cards.
  
  The global tool patch took over `bash` and the three `terminal_*` tools because the exclusion list defaults to empty, so their own renderers were replaced by the generic ccstyle card. That dropped information the cards exist to show: the `terminal <id>` label and the `/ps to inspect` hint on a yielded command, the stdout preview, the changed-files note, and the settled/running breakdown on `terminal_wait`. A one-line command rendered as `4 lines returned` instead of its output.
  
  Both packages now coexist without configuration. The `bash` override is recognized by its `yield_time_ms` parameter, which Pi's built-in bash does not declare; the three `terminal_*` names belong to that package alone.

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Address three review findings.
  
  **Narrow terminals.** The footer prepended its editor-alignment indent before clamping the payload, so a width smaller than the indent still emitted at least one payload column plus the full indent — `render(1)` produced three columns. `indentFooterLine` now clamps the indent to the width first and gives the payload whatever remains, down to zero.
  
  **Prompt separation.** The `@session:[...]` header, including the instruction that referenced sessions are untrusted context, was inlined in `extensions/feature/reference/session.ts`. It moved to `lib/prompt.ts` as `SESSION_REFERENCE_HEADER`, next to the subagent delegation text, so all model-facing wording lives in one auditable place.
  
  **Main-screen patch cleanup.** `installMainScreenDoRenderPatch` patched `TuiMainScreen.prototype.applyLineResets` but returned nothing, so unloading the extension left the stale-scrollback behavior active until the process restarted. It now returns an ownership-guarded disposer, called from `session_shutdown`, that restores the original method only when the slot still holds this installation.

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Restore the docked-bash prototype patch when an interactive session shuts down, and keep headless sessions from installing it. Clear disposed main-screen patch registry entries even when another extension wraps the method.

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Render reasoning text with the theme's `thinkingText` slot instead of `dim`.
  
  `thinkingText` is Pi's dedicated "Thinking block text color" — Pi's own thinking renderer uses it — so reasoning now follows whatever the active theme sets for it. The `Thought for 6s` heading and the `N more lines` hint stay on `dim`, which keeps them reading as metadata rather than content.

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Show the collapsed reasoning card whenever `previewLines` is set, instead of only when Pi's `hideThinkingBlock` is on.
  
  Upstream deferred to Pi's own Thinking Markdown renderer whenever the user kept thinking visible, so `previewLines` was silently inert for the default configuration: long reasoning streamed in full and kept scrolling the transcript. `previewLines > 0` now takes over the reasoning block regardless of `hideThinkingBlock`, so the preview window and the `N more lines` hint apply. `previewLines: 0` still leaves Pi's renderer in place.

- [#171](https://github.com/TianZuo555/pi-extensions/pull/171) [`8aad15a`](https://github.com/TianZuo555/pi-extensions/commit/8aad15a5d566564b39f6b8dd0e3c79e8aafdc46d) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Tighten the git and rate chips.
  
  The git chip dropped its parentheses: `(+12 −4)` is now ` +12/−4`, which reads as one token instead of a nested group. The rate chip replaced the `avg` prefix with the same md-flash glyph the rest of the footer uses, so `avg 211 tok/s` is now `󰉁 211 tok/s`. `live` keeps its word, since that mode has to stay distinguishable from the average.
