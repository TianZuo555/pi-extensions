# @tian.zuo/pi-rex

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-rex/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

The [Rex](https://www.superlogical.com/rex/docs/automate/agent-skill) session-start hook for the [pi coding agent](https://pi.dev). The extension also names the Rex session after the project folder or worktree, names the tab from the first prompt, and resumes pi in each pane after a Rex restart. You install nothing else: the extension also writes the shell hook that resumes pi.

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

Rex gives each session and each tab a generated name. The extension names the session after the project folder, and gives each tab a task name from the first prompt. The agent does not run a rename command.

The session name is the current folder name, as-is. In a linked git worktree, the name is `Wrktree—<main repository folder>—<branch>`, such as `Wrktree—pi-tian-extensions—docs/pi-layerfs-spec`. A detached worktree uses the first seven characters of the commit. The extension finds the worktree with `git worktree list --porcelain`. If git fails or the folder is not a git repository, the folder name is used.

On the first user prompt of a pi session, the extension runs `rex whoami --json` as a cheap check that the Rex server answers. If it does, the extension reads the folder and worktree, then makes one model call on the current session model. The call asks for a tab label: 2 to 4 lowercase English words, joined by hyphens. The call runs in the background, so the first response is not delayed. After the model replies, the extension reads the current labels and runs:

```bash
rex session inspect "$REX_SESSION" --json
rex session rename "$REX_SESSION" SESSION_LABEL     # first tab only
rex window rename -s "$REX_SESSION" WINDOW_ID TAB_LABEL
```

The session name does not depend on the model. If the model call fails or returns no label, the session is still renamed; only the tab keeps its old name.

The labels are read after the model call. A rename made while the call runs wins.

Rex orders tabs by ID, which comes from the creation time. The first tab carries the session label. A later tab gets its own label and never renames the parent session.

The extension replaces a label only when the label is still generated:

- A session label is generated when it is two lowercase words, such as `shy-strait`, or a worktree label from this extension that starts with `Wrktree—`.
- A tab label is generated when it is `Window <id>`, such as `Window 629d2113`.

A hand-set label is kept. A one-word folder label, such as `repo`, is not recognized as generated, so a later pi session in the same tab keeps it. Naming runs once per pi session. If a Rex command fails, the old name stays and the agent continues.

Because the extension names the session, it removes the Rex naming paragraph from the `<rex>` section. It adds one line instead: the names are automatic, and the agent must not rename them unless the user asks. This also overrides the `rex` skill rule that says to rename only when the user asks.

## Resume after a Rex restart

Rex restores sessions, tabs, panes, and scrollback after a restart. Each pane keeps its block ID, but Rex starts a new shell in the pane, not pi. A dead process cannot start itself, so the work needs two parts. The extension records the pi session of each pane, and it writes a shell hook. The hook starts pi again in the restored pane.

When `REX_BLOCK` is set in TUI mode, the extension writes `~/.pi/agent/rex-resume/<block id>` (below `PI_CODING_AGENT_DIR` when it is set). It writes the record when a session starts and after each prompt, because pi creates the session file only after the first message. The record holds the working directory on line 1, then the command, one argument per line:

```text
/Users/you/src/app
pi
--session
/Users/you/.pi/agent/sessions/--Users-you-src-app--/2026-11-05T05-52-27-656Z_01a1....jsonl
```

The record stays when pi stops because of SIGHUP or SIGTERM, or because the terminal is gone. A Rex restart does one of these. The record stays for `/reload`, `/resume`, and `/fork`, and the next session writes its own record. `/new` removes the record until the new session has a file, so a restart right after `/new` does not reopen the previous session. The record is removed when you quit pi (Ctrl+D, Ctrl+C twice, `/quit`). Print, JSON, and RPC runs write no record.

### The shell hook

On the first pi session in a Rex pane, the extension writes the hook for the pane's shell and shows one notice. It reads the shell from `SHELL`. A Windows pane has no `SHELL`, so there it reads `PSModulePath`.

| Shell      | File                                                                                                                     | How the hook is stored                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| fish       | `~/.config/fish/conf.d/rex-resume.fish`, below `XDG_CONFIG_HOME`                                                         | The whole file. It starts with the marker line `# Generated by @tian.zuo/pi-rex.`     |
| zsh        | `.zshrc` in `ZDOTDIR` or the home folder                                                                                 | A block between the lines `# >>> tian.zuo/pi-rex >>>` and `# <<< tian.zuo/pi-rex <<<` |
| bash       | The startup file a login shell reads first: `.bash_profile`, `.bash_login`, or `.profile`; `.profile` when none exists   | The same marked block                                                                 |
| PowerShell | `profile.ps1` in `Documents\PowerShell` on Windows, and in the `powershell` folder of the config home on macOS and Linux | The same marked block                                                                 |

The extension never creates `.bash_profile`, because that file would hide an existing `.profile`. It changes only its own text: a fish file without the marker, or a startup file without the block, stays as it is.

The hook runs when a new shell starts in a restored pane. A new pane has a new block ID, so it has no record and the hook does nothing. The hook removes the record before it starts pi, and pi writes a new one. The hook always runs `pi --session <file>`: it does not restore the flags of the first launch, so a pane that ran `pi -e ./packages/pi-rex` resumes with plain `pi`.

This is the fish hook the extension writes. The `zsh`, `bash`, and PowerShell hooks do the same work in the syntax of their shell.

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

The hook runs before the first prompt, after the rest of the config is loaded. For fish it waits at that prompt; for zsh and bash it runs at the end of the startup file.

A bash hook runs only in an interactive shell, so a script that sources `.profile` does not start pi.

## Settings

The extension reads the `rex` section of the pi settings file. Add the section to `~/.pi/agent/settings.json`.

| Key            | Type    | Default | Description                                                                                                                                |
| -------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `rex.autoName` | boolean | `true`  | Name the Rex session after the folder or worktree, and the tab from the first prompt. `false` keeps the Rex names and the Rex naming text. |
| `rex.resume`   | boolean | `true`  | Record each pane's pi session, and write the fish hook that resumes pi after a Rex restart. `false` writes no record and no hook file.     |

Example:

```json
{
  "rex": {
    "autoName": false,
    "resume": false
  }
}
```

Any value other than `false` keeps the feature on.

## Known limits

- The extension decides "generated" from the shape of the label. A hand-set two-word session label, such as `fix-login`, is replaced.
- A one-word folder label is not recognized as generated. If you start a new pi session in another folder in the same Rex tab, the session keeps the old folder name.
- The model reply must be one tab label. A prose reply leaves the old tab name in place; the session is still renamed.
- The naming call uses the current session model. A reasoning model can spend part of the token budget before it writes the label.
- The `<rex>` removal reads one string from the Rex output: the paragraph that holds `rex session rename`. A change to that wording stops the removal.
- Resume writes a hook for `fish`, `zsh`, `bash`, and PowerShell. A pane that runs `sh`, `cmd.exe`, or another shell starts no pi after a restart. The records still exist, so a shell hook you write by hand can use them.
- The fish, zsh, and bash hooks ran in real shells. The PowerShell hook did not: it is written from the PowerShell syntax alone. A Windows pane needs `pi` on `PATH`, which is the `.cmd` shim that pi installs.
- The extension writes the hook only in the TUI, inside a Rex pane. A machine that never starts pi in a Rex pane gets no hook file.
- The hook starts `pi --session <file>`, so it does not restore the flags of the first launch. A pane that ran `pi -e ./packages/pi-rex` resumes without the local extension.
- A second interactive fish in the same pane, started while pi runs, also reads the record. It can start a second pi on the same session and remove the record; the next prompt in the first pi writes the record again.
- When you close a pane while pi runs in it, pi gets SIGHUP and its record stays. The file is small, and Rex never reuses a block ID.
- A pi started by the fish hook runs inside a prompt event, so Ctrl+Z may not suspend it.

## License

[MIT](../../LICENSE) © Tian Zuo
