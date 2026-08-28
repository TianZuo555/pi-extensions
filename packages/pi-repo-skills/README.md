# @tian.zuo/pi-repo-skills

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-repo-skills/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

Per-repository skill enable and disable controls for the [pi coding agent](https://pi.dev).

```bash
pi install npm:@tian.zuo/pi-repo-skills
```

## How it works

Turns individual skills on/off per repository. Disabled skills are removed from
the system prompt (like `disable-model-invocation: true`), so the model won't
auto-load them. State lives in `~/.pi/repo-skills/config.json`, keyed by git
root.

`disabled` is stored as an array of skill names or the sentinel `"ALL"`
(every skill off, future-proof against newly installed skills).

## Commands

- `/skills` — checkbox TUI: `↑↓/jk` move, `space` toggle, `a` disable all,
  `n` enable all, `enter` save, `esc` cancel.
- `/skills-list` — list all repos with overrides.
- `/skills-reset` — clear this repo's overrides.

## License

[MIT](../../LICENSE) © Tian Zuo
