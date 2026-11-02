# @tian.zuo/pi-rex

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-rex/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

The [Rex](https://www.superlogical.com/rex/docs/automate/agent-skill) session-start hook for the [pi coding agent](https://pi.dev).

```bash
pi install npm:@tian.zuo/pi-rex
```

## How it works

`rex skill setup` writes a SessionStart hook for Claude Code and Codex. The hook tells the agent that it runs in a Rex terminal. The hook also supplies the session ID and the pane ID. Rex writes the skill for pi, but pi has no command hooks.

This extension supplies the hook for pi. When a session starts and `REX_SESSION` is set, the extension runs this command:

```bash
rex __internal session-start --agent pi
```

The extension adds the output to the system prompt as a `<rex>` section. Outside a Rex terminal, the extension does nothing. If the command fails, pi shows a warning. The system prompt does not change.

Run `rex skill setup` to install the skill. This extension does not install the skill.

## Settings

The extension reads the `rex` section of the pi settings file. Add the section to `~/.pi/agent/settings.json`.

| Key             | Type    | Default | Description                  |
| --------------- | ------- | ------- | ---------------------------- |
| `rex.renameTab` | boolean | `false` | Tell pi to name the Rex tab. |

Example:

```json
{
  "rex": {
    "renameTab": true
  }
}
```

Any value other than `true` keeps tab naming off.

## Naming

Rex gives each session and each tab a generated name. The agent can replace these names with task names.

### Session naming

Session naming is on for a session with one tab. Rex supplies the naming instructions in the session-start output. The extension does not run `rex session rename`. No setting controls session naming.

When the session has more than one tab, the extension removes the session-naming paragraph. It adds a second instruction instead: keep the session label and do not rename the session. A session is the parent of its tabs, so a tab must not rename the parent.

The extension counts the tabs with `rex session inspect "$REX_SESSION" --json`. If that command fails, the Rex text stays unchanged.

### Tab naming

Set `rex.renameTab` to `true` to let pi name the tab. The extension then adds tab instructions to the `<rex>` section. The instructions tell pi to run:

```bash
rex window rename -s "$REX_SESSION" WINDOW_ID LABEL
```

A session is the parent. A tab is the child. pi names the session first. Then pi reads its window ID with `rex whoami --json`. It compares that ID with the window IDs of the session from `rex window ls`. The first tab takes the session label. A later tab gets its own label. pi keeps a label that already fits the work. If the rename fails, pi continues the task and does not show a message.

## Known limits

- The Rex CLI does not report whether a label is generated or set by hand. The extension decides from the tab count only. A session with one tab and a hand-set label can still lose that label.
- The session rule reads one string from the Rex output: the paragraph that holds `rex session rename`. A change to that wording stops the removal.
- The two instructions are prompt text. An agent can ignore them. The extension never runs a rename command itself.

## License

[MIT](../../LICENSE) © Tian Zuo
