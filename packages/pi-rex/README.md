# @tian.zuo/pi-rex

Release notes: [changelog](https://github.com/TianZuo555/pi-extensions/blob/main/packages/pi-rex/CHANGELOG.md) · [GitHub releases](https://github.com/TianZuo555/pi-extensions/releases)

This extension connects the [pi coding agent](https://pi.dev) to [Rex](https://www.superlogical.com/rex/docs/automate/agent-skill). It does four things:

- It tells pi that pi runs in a Rex terminal.
- It gives a name to the Rex session and to the tab.
- It reports the pi prompt to the Rex activity view.
- It gives the agent one tool that moves the agent into a git worktree.

Install the extension:

```bash
pi install npm:@tian.zuo/pi-rex
```

## Session start

The command `rex skill setup` writes a SessionStart hook for Claude Code and Codex. The hook tells the agent that it runs in a Rex terminal. The hook also gives the session ID and the pane ID. Pi has no command hooks, so Rex writes no hook for pi.

This extension is the hook for pi. When a pi session starts, the extension runs this command:

```bash
rex __internal session-start --agent pi
```

The extension adds the output to the system prompt as a `<rex>` section.

- The extension runs only when `REX_SESSION` or `REX_BLOCK` is set. Outside a Rex terminal, the extension does nothing.
- If the command fails, pi shows a warning. The system prompt does not change.

The extension does not install the Rex skill. To install the skill, run `rex skill setup`.

## Names

Rex gives each session and each tab a generated name. The extension replaces these names:

- The session gets the name of the project folder.
- Each tab gets a task name from the first prompt.

The agent does not run a rename command.

### Session name

The session name is the name of the current folder. In a linked git worktree, the name has this format: `Wrktree—<main repository folder>—<branch>`. An example is `Wrktree—pi-tian-extensions—docs/pi-layerfs-spec`. A detached worktree uses the first seven characters of the commit.

The extension finds the worktree with `git worktree list --porcelain`. If git fails, or if the folder is not a git repository, the extension uses the folder name.

### Tab name

On the first user prompt of a pi session, the extension does these steps:

1. It runs `rex whoami --json`. This is a fast check that the Rex server answers.
2. It reads the folder and the worktree.
3. It makes one model call on the current session model. The call asks for a tab label: 2 to 4 lowercase English words, with hyphens between the words.
4. It reads the current labels.
5. It runs the rename commands:

```bash
selector=${REX_SESSION:-$REX_BLOCK}
rex session inspect "$selector" --json
rex session rename "$selector" SESSION_LABEL     # first tab only
rex window rename -s "$selector" WINDOW_ID TAB_LABEL
```

The model call runs in the background. Thus the first response does not wait for the call.

The session name does not come from the model. If the model call fails, or if the reply is not a label, the extension still renames the session. Only the tab keeps its old name.

The extension reads the labels after the model call. If a person renames the session or the tab during the call, that name stays.

Rex sorts tabs by ID, and the ID comes from the time of creation. Only the first tab of a session renames the session. A later tab renames only itself.

### Generated and hand-set labels

The extension replaces a label only when the label is still a generated label:

- A session label is generated when it is two lowercase words, such as `shy-strait`. A worktree label from this extension, which starts with `Wrktree—`, is also generated.
- A tab label is generated when it is `Window <id>`, such as `Window 629d2113`.

The extension keeps a hand-set label. A one-word folder label, such as `repo`, is not a generated label. Thus a later pi session in the same tab keeps that label.

Naming runs one time for each pi session. If a Rex command fails, the old name stays, and the agent continues.

The extension names the session, so it removes the Rex naming paragraph from the `<rex>` section. It adds one line in its place. The line tells the agent that the names are automatic. The line also tells the agent not to rename them, unless the user asks. This line also overrides the rule in the `rex` skill about renames.

## Program activity

In a Rex TUI session, the extension reports the current pi prompt to Rex through OSC 7501. Rex then shows the prompt while pi works and after the run ends. The extension shortens the message to one safe line for the activity view.

| Run result | Reported state |
| ---------- | -------------- |
| Cancelled  | `idle`         |
| Completed  | `done`         |
| Failed     | `error`        |

The prompt has its own status record, `pi-prompt`. Pi continues to report its root status. The root status includes open dialogs and login screens.

To stop the activity reports, set `PI_PROGRAM_STATUS=0`.

## Move to a worktree

The extension registers one tool, `rex_worktree_move`. The tool moves the running agent into a git worktree. The conversation stays. Use it when the agent starts a task in a new worktree.

The tool has `codemode` exposure. Thus the model does not see the tool as a separate declaration. The agent calls the tool from a codemode script:

```js
await tools.rex_worktree_move({ path: "~/Workspace/worktrees/repo-feature" });
```

The `path` parameter is the worktree folder. The folder must exist, so create the worktree first.

### Procedure

The tool does these steps:

1. It runs `rex whoami --json` to find the current tab and the current session.
2. It runs `rex client ls -s <session> --json` to find the Rex apps that have the current session open.
3. It makes the session label from the worktree, as in [Session name](#session-name).
4. It runs `rex new <label> --cwd <path> --json`. This command makes a new session with one shell tab.
5. It runs `rex window move <tab> --to <session> --focus`. Pi continues to run during the move.
6. It closes the shell tab of the new session.
7. If the old session has no tabs, it removes the old session with `rex kill`.
8. It tells each Rex app from step 2 to show the moved tab, with `rex -C <app> do session.select`.
9. If `REX_SESSION` is set, it sets `REX_SESSION` to the new session ID.
10. It starts the internal command `/rex-worktree-switch <path>`.
11. It tells the agent to end the turn.

If the move fails, the tool removes the new session. The tab stays in the old session.

### Rex app view

A Rex app continues to show the session that it showed before the move. Thus, without step 8, the tab goes out of view, and the app shows the old session.

A Rex app does step 8 only when its Remote Control setting is on. To turn it on, open Rex Settings > General. If an app refuses, the tool result gives the name of the app and the reason. The agent then tells you to select the new session by hand.

Rex does not tell which app shows the tab. Thus all Rex apps that have the old session open go to the moved tab. This includes the apps on your other computers.

### The session switch

A move of the tab does not change the folder of pi. Only a command can replace the pi session, so the tool starts the command `/rex-worktree-switch`. You do not type this command. The command does these steps:

1. It waits until the turn ends.
2. It copies the conversation into a new session for the worktree, with `SessionManager.forkFrom`.
3. It switches pi to the new session.
4. It sends one user message that tells the agent to continue in the worktree.

After the switch, pi makes its tools, its system prompt, and its context files again for the worktree. The session start runs again, so the naming and the `<rex>` section use the worktree.

The old session file stays in the session list of the old folder.

## Removal of the old resume hook

Version 0.4 recorded the pi session of each pane. It also installed a shell hook that started pi again after a Rex restart. Rex now does this work itself, so the extension no longer does it.

The old hook and its records can start pi a second time, or open an old session. Thus the extension removes them. This occurs one time for each pi process, on the first session start in a Rex TUI pane. The extension removes only text that it wrote:

| Item            | Location                                                                                                   | Removal condition                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| fish hook       | `~/.config/fish/conf.d/rex-resume.fish`, below `XDG_CONFIG_HOME`                                           | The file starts with `# Generated by @tian.zuo/pi-rex.`                       |
| zsh hook        | `.zshrc` in `ZDOTDIR` or in the home folder                                                                | The block between `# >>> tian.zuo/pi-rex >>>` and `# <<< tian.zuo/pi-rex <<<` |
| bash hook       | `.bash_profile`, `.bash_login`, and `.profile`                                                             | The same block                                                                |
| PowerShell hook | `profile.ps1` in `Documents\PowerShell`, `Documents\WindowsPowerShell`, and the `powershell` config folder | The same block                                                                |
| Records         | `~/.pi/agent/rex-resume`, below `PI_CODING_AGENT_DIR` when it is set                                       | Always                                                                        |

For each changed hook file, pi shows one notice. A print, JSON, or RPC run changes no file.

## Settings

The extension reads the `rex` section of the pi settings file. Add the section to `~/.pi/agent/settings.json`.

| Key            | Type    | Default | Description                                                                                      |
| -------------- | ------- | ------- | ------------------------------------------------------------------------------------------------ |
| `rex.autoName` | boolean | `true`  | Gives names to the Rex session and the tab. `false` keeps the Rex names and the Rex naming text. |

Example:

```json
{
  "rex": {
    "autoName": false
  }
}
```

Only the value `false` stops the feature.

Version 0.5 removes the `rex.resume` and `rex.resumeCommand` settings. The extension ignores them.

## Known limits

- The extension uses the shape of a label to find a generated label. Thus it replaces a hand-set label of two words, such as `fix-login`.
- A one-word folder label is not a generated label. If you start a new pi session in a different folder in the same Rex tab, the session keeps the old folder name.
- The model reply must be one tab label. If the reply is a sentence, the tab keeps its old name. The extension still renames the session.
- The naming call uses the current session model. A reasoning model can use part of the token limit before it writes the label.
- The extension finds the Rex naming paragraph from one text: `rex session rename`. If Rex changes that text, the extension does not remove the paragraph.
- Only a codemode script can call `rex_worktree_move`. If codemode is off, the agent cannot use the tool. You can type `/rex-worktree-switch <path>` to switch the session without a move of the tab.
- The tool gives the session name from the worktree. If a session with that name exists, Rex makes a second session with the same name.
- The command `/rex-worktree-switch` shows in the `/` command list.

## License

[MIT](../../LICENSE) © Tian Zuo
