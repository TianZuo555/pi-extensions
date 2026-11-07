# @tian.zuo/pi-ask-user

## 0.3.0

### Minor Changes

- [#209](https://github.com/TianZuo555/pi-extensions/pull/209) [`927bb89`](https://github.com/TianZuo555/pi-extensions/commit/927bb891499d455b8badcae1190e4426b8a5b386) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Pick an option with its number key. Pressing `1`–`6` answers that option and advances to the next question, or submits a complete form. The number on the **Other** row opens the custom-answer editor. Each row now shows its number, and the help line reports the valid range.

## 0.2.2

### Patch Changes

- [#189](https://github.com/TianZuo555/pi-extensions/pull/189) [`df2daf5`](https://github.com/TianZuo555/pi-extensions/commit/df2daf52f42a1a7932a88b368386e1bfbacf3635) Thanks [@TianZuo555](https://github.com/TianZuo555)! - Report `blocked` to OSC 7501 terminals, such as Rex, while the TUI form waits for an answer.

  Pi 1.5 lets an inline `ctx.ui.custom()` component pass `blocked: { kind, message }`. The form now passes the question label. Pi clears the status when the form closes and keeps the status of any dialog below it, so stacked dialogs no longer overwrite each other. Pi 1.4 ignores the option and shows the form without a blocked status.

## 0.2.1

- Changelog tracking was introduced after this release.
