# @tian.zuo/pi-rex

## 0.2.0

### Minor Changes

- [#204](https://github.com/TianZuo555/pi-extensions/pull/204) [`c801328`](https://github.com/TianZuo555/pi-extensions/commit/c8013289dc6f333032695a9bd0b6eb1b527e12e1) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Name the Rex session and tab from the first prompt. The extension asks the current session model for one label, then runs `rex session rename` for the first tab and `rex window rename` for the current tab. The model call runs in the background, so the first response is not delayed. A hand-set label is kept. Set `rex.autoName` to `false` to turn automatic naming off. The `rex.renameTab` setting is removed.

## 0.1.1

### Patch Changes

- Ship `lib/` in the published package. Version 0.1.0 did not load: `index.ts` imports `./lib/rex-output.ts` and `./lib/prompt.ts`, but `files` left `lib/` out of the tarball.

## 0.1.0

### Minor Changes

- [#188](https://github.com/TianZuo555/pi-extensions/pull/188) [`dae7bfa`](https://github.com/TianZuo555/pi-extensions/commit/dae7bfab074274318518b7e66601848db7a26b3c) Thanks [@TianZuo555](https://github.com/TianZuo555)! - First published release.

  Rex installs a SessionStart hook for Claude Code and Codex, but not for pi. This package supplies that hook. In a Rex terminal, it runs `rex __internal session-start --agent pi` when a session starts. It adds the output to the system prompt as a `<rex>` section, so pi knows its Rex session and pane without a search.

  Set `rex.renameTab` to `true` in the pi settings to also tell pi to name the Rex tab. With tab naming on, the first tab of a session takes the session label and a later tab gets its own label.

  When the session already has more than one tab, the extension keeps the session label: it removes the Rex session-naming paragraph and adds an instruction to keep the current label. This stops a new tab from renaming its parent session. A failed `rex session inspect` leaves the Rex text unchanged.
