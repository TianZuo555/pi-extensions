# @tian.zuo/pi-rex

## 0.1.0

### Minor Changes

- [#188](https://github.com/TianZuo555/pi-extensions/pull/188) [`dae7bfa`](https://github.com/TianZuo555/pi-extensions/commit/dae7bfab074274318518b7e66601848db7a26b3c) Thanks [@TianZuo555](https://github.com/TianZuo555)! - First published release.

  Rex installs a SessionStart hook for Claude Code and Codex, but not for pi. This package supplies that hook. In a Rex terminal, it runs `rex __internal session-start --agent pi` when a session starts. It adds the output to the system prompt as a `<rex>` section, so pi knows its Rex session and pane without a search.

  Set `rex.renameTab` to `true` in the pi settings to also tell pi to name the Rex tab. With tab naming on, the first tab of a session takes the session label and a later tab gets its own label.

  When the session already has more than one tab, the extension keeps the session label: it removes the Rex session-naming paragraph and adds an instruction to keep the current label. This stops a new tab from renaming its parent session. A failed `rex session inspect` leaves the Rex text unchanged.
