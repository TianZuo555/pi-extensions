# @tian.zuo/pi-rex

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-rex/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

The [Rex](https://www.superlogical.com/rex/docs/automate/agent-skill) session-start hook for the [pi coding agent](https://pi.dev). The extension also names the Rex session and tab from the first prompt.

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

## Naming

Rex gives each session and each tab a generated name. The extension replaces these names with task names. The agent does not run a rename command.

On the first user prompt of a pi session, the extension runs `rex whoami --json` as a cheap check that the Rex server answers. If it does, the extension makes one model call on the current session model. The call asks for a label: 2 to 4 lowercase English words, joined by hyphens. The call runs in the background, so the first response is not delayed. After the model replies, the extension reads the current labels and runs:

```bash
rex session inspect "$REX_SESSION" --json
rex session rename "$REX_SESSION" LABEL      # first tab only
rex window rename -s "$REX_SESSION" WINDOW_ID LABEL
```

The labels are read after the model call. A rename made while the call runs wins.

Rex orders tabs by ID, which comes from the creation time. The first tab carries the session label. A later tab gets its own label and never renames the parent session.

The extension replaces a label only when the label is still generated:

- A session label is generated when it is two lowercase words, such as `shy-strait`.
- A tab label is generated when it is `Window <id>`, such as `Window 629d2113`.

A hand-set label is kept. Naming runs once per pi session. If the model call or a Rex command fails, the old name stays and the agent continues.

Because the extension names the session, it removes the Rex naming paragraph from the `<rex>` section. It adds one line instead: the names are automatic, and the agent must not rename them unless the user asks. This also overrides the `rex` skill rule that says to rename only when the user asks.

## Settings

The extension reads the `rex` section of the pi settings file. Add the section to `~/.pi/agent/settings.json`.

| Key            | Type    | Default | Description                                                                                              |
| -------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `rex.autoName` | boolean | `true`  | Name the Rex tab and session from the first prompt. `false` keeps the Rex names and the Rex naming text. |

Example:

```json
{
  "rex": {
    "autoName": false
  }
}
```

Any value other than `false` keeps automatic naming on.

## Known limits

- The extension decides "generated" from the shape of the label. A hand-set two-word session label, such as `fix-login`, is replaced.
- The model reply must be one label. A prose reply leaves the old name in place.
- The naming call uses the current session model. A reasoning model can spend part of the token budget before it writes the label.
- The `<rex>` removal reads one string from the Rex output: the paragraph that holds `rex session rename`. A change to that wording stops the removal.

## License

[MIT](../../LICENSE) © Tian Zuo
