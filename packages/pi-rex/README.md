# @tian.zuo/pi-rex

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-rex/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

The [Rex](https://www.superlogical.com/rex/docs/automate/agent-skill) session-start hook for the [pi coding agent](https://pi.dev). The extension also names the Rex session and tab from the first prompt, and records each pane's pi session so pi can resume after a Rex restart.

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

## Resume after a Rex restart

Rex restores sessions, tabs, panes, and scrollback after a restart. Each pane keeps its block ID, but Rex starts a new shell in the pane, not pi. The extension records the pi session of each pane, so a shell hook can start pi again.

When `REX_BLOCK` is set in TUI mode, the extension writes `~/.pi/agent/rex-resume/<block id>` (below `PI_CODING_AGENT_DIR` when it is set). It writes the record when a session starts and after each prompt, because pi creates the session file only after the first message. The record holds the working directory on line 1, then the command, one argument per line:

```text
/Users/you/src/app
pi
--session
/Users/you/.pi/agent/sessions/--Users-you-src-app--/2026-11-05T05-52-27-656Z_01a1....jsonl
```

The record stays when pi stops because of SIGHUP or SIGTERM, or because the terminal is gone. A Rex restart does one of these. The record stays for `/reload`, `/resume`, and `/fork`, and the next session writes its own record. `/new` removes the record until the new session has a file, so a restart right after `/new` does not reopen the previous session. The record is removed when you quit pi (Ctrl+D, Ctrl+C twice, `/quit`). Print, JSON, and RPC runs write no record.

The extension cannot start a program in a Rex pane, so the shell must read the record. Add this hook to `~/.config/fish/config.fish` (or a file in `conf.d/`):

```fish
if status is-interactive; and set -q REX_BLOCK
    function __rex_resume --on-event fish_prompt
        functions -e __rex_resume
        set -l agent_dir $HOME/.pi/agent
        # Expand ~ as pi does: fish does not expand it inside a variable.
        set -q PI_CODING_AGENT_DIR; and set agent_dir (string replace -r -- '^~(?=/|$)' $HOME $PI_CODING_AGENT_DIR)
        set -l file $agent_dir/rex-resume/(string replace -- 'block:' '' $REX_BLOCK)
        test -f $file; or return
        set -l record (cat $file)
        test -n "$record[1]"; or return
        cd -- $record[1]; or return
        rm -f $file
        $record[2..]
    end
end
```

The hook runs once, before the first prompt, after the rest of the config is loaded. A new pane has a new block ID, so it has no record. Only a pane that Rex restored while pi ran in it has one. The hook removes the record before it starts pi, and pi writes a new one. The hook always runs `pi --session <file>`: it does not restore the flags of the first launch, so a pane that ran `pi -e ./packages/pi-rex` resumes with plain `pi`.

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
- Resume needs the shell hook. Without it, the records do nothing.
- The hook starts `pi --session <file>`, so it does not restore the flags of the first launch. A pane that ran `pi -e ./packages/pi-rex` resumes without the local extension.
- A second interactive fish in the same pane, started while pi runs, also reads the record. It can start a second pi on the same session and remove the record; the next prompt in the first pi writes the record again.
- When you close a pane while pi runs in it, pi gets SIGHUP and its record stays. The file is small, and Rex never reuses a block ID.
- A pi started by the fish hook runs inside a prompt event, so Ctrl+Z may not suspend it.

## License

[MIT](../../LICENSE) © Tian Zuo
