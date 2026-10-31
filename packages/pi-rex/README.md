# @tian.zuo/pi-rex

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-rex/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

The [Rex](https://www.superlogical.com/rex/docs/automate/agent-skill) session-start hook for the [pi coding agent](https://pi.dev).

```bash
pi install npm:@tian.zuo/pi-rex
```

## How it works

`rex skill setup` installs a SessionStart hook for Claude Code and Codex. The
hook tells the agent that it runs in a Rex terminal, and which session and pane
it is in. Rex installs the skill for pi, but it has no hook for pi.

This extension supplies the hook. When a session starts and `REX_SESSION` is
set, it runs:

```bash
rex __internal session-start --agent pi
```

It adds the output to the system prompt as a `<rex>` section. Outside a Rex
terminal, the extension does nothing. When the command fails, pi shows a
warning and the prompt does not change.

Install the skill with `rex skill setup`. This extension does not install it.

## License

[MIT](../../LICENSE) © Tian Zuo
