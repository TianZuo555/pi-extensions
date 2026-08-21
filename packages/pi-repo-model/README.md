# @tian.zuo/pi-repo-model

Per-repository default model and thinking-level preferences for the [pi coding agent](https://pi.dev).

```bash
pi install npm:@tian.zuo/pi-repo-model
```

## How it works

Stores one model preference per repository in `~/.pi/repo-model/config.json`
and applies it at session start (default triggers: fresh start + new session).
An explicit `pi --model ...` takes precedence on startup. Selections are keyed
by git root, so each repository keeps its own preference without touching
global settings or the repo's own `.pi/` folder.

## Commands

- `/repo-model` — pick a model, then a thinking level, from dropdowns.
- `/repo-model provider/model[:thinking]` — set directly, e.g.
  `/repo-model cursor/composer-2.5:high`.
- `/repo-model-unset` — clear the current repo's default.
- `/repo-model-list` — list every configured repo.

## License

[MIT](../../LICENSE) © Tian Zuo
