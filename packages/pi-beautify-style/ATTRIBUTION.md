# Attribution

`pi-beautify-style` is a fork. Most of the code under `extensions/` is vendored
verbatim from upstream projects and then adapted to this monorepo.

## pi-cc-extensions

The Claude Code-style TUI — tool cards, compact mode, rich diffs, footer chips,
`/context`, session/subagent references, mouse interaction, and the bundled
`cc-dark`/`cc-light` themes — comes from
[minuque/pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)
(commit `4b93074`), Copyright (c) 2026 minuque, used under the MIT License.

Local changes are marked with comments in the affected files. They are:

- `ask_user` (from `@tian.zuo/pi-ask-user`) reuses the `ask_user_question`
  card, including its `choice: { label, wasCustom }` answer shape.
- `terminal_wait`, `terminal_stop`, and `terminal_log_read` (from
  `@tian.zuo/pi-background-terminals`) reuse the shell card and timing path.
- The footer treats `setStatus("usage")` — the key used by
  `@tian.zuo/pi-usage` — as the usage chip.

## pi-tool-display

The rich diff renderer under `extensions/renderer/tool/diff/` is adapted from
[MasuRii/pi-tool-display](https://github.com/MasuRii/pi-tool-display) at commit
`91cef7580078371f8dc49a8607222807ad6a424d`, Copyright (c) MasuRii and
pi-tool-display contributors, used under the MIT License. The upstream notice
is reproduced in `extensions/renderer/tool/diff/ATTRIBUTION.md`.

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
