# @tian.zuo/pi-ask-user

## 0.2.2

### Patch Changes

- [#189](https://github.com/TianZuo555/pi-extensions/pull/189) [`df2daf5`](https://github.com/TianZuo555/pi-extensions/commit/df2daf52f42a1a7932a88b368386e1bfbacf3635) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Report `blocked` to OSC 7501 terminals, such as Rex, while the TUI form waits for an answer.
  
  Pi reports `blocked` only for its built-in `select`, `input`, and `editor` dialogs. The `ask_user` form uses `ctx.ui.custom()`, so Rex showed no status while the form was open. The form now writes `blocked` (`kind=question`, with the question label as the message) when it opens. When it closes, it restores the `working` status that Pi reported for the run.

## 0.2.1

- Changelog tracking was introduced after this release.
