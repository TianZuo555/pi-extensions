# pi-tian-subagents

Delegate bounded tasks to isolated Pi child processes from [pi](https://pi.dev).

```bash
pi install npm:pi-tian-subagents
```

## What it does

- **`subagent` tool** — spawn a profile-locked child `pi --mode rpc` process, return a bounded text report with nested usage
- **Built-in profiles** — `scout`, `planner`, `reviewer`, `oracle` (read-only), `worker` (git worktree + writes)
- **Parallel runs** — call `subagent` multiple times in one turn (sibling tool calls)
- **Background mode** — `mode: "background"` returns immediately; completion arrives as a follow-up notification
- **`subagent_status` / `subagent_cancel`** — poll or cancel background runs
- **`/agents` command** — list session runs and available profiles

Capabilities (model, tools, workspace) come from the profile — not from tool arguments.

## Profiles

Profiles live as Markdown with YAML frontmatter:

| Source | Location |
|---|---|
| Built-in | shipped in `profiles/` |
| User | `~/.pi/agent/agents/*.md` |
| Project | `.pi/agents/*.md` (requires trusted project + first-use approval by content hash) |

Reference profiles by short name (`scout`) or qualified id (`builtin/reviewer`, `project/my-agent`).

## Example

```json
{
  "profile": "scout",
  "task": "Find where session cost is accumulated and summarize the flow.",
  "context": "Repo is pi-tian-extensions; subagents live in packages/pi-subagents."
}
```

Background:

```json
{
  "profile": "planner",
  "task": "Draft a test plan for worktree cleanup.",
  "mode": "background"
}
```

## Session limits

- Max **4** concurrent child processes
- Max **20** runs per parent session
- Soft cost warning at 80% of session ceiling (default $5; override via `settings.json` → `subagents.sessionSoftCostUsd`)

## Child isolation

Children use `--no-extensions` (no extension MCP servers), `--no-skills`, and related flags. Pi has no built-in MCP; `process.env` is inherited for API keys.

## Worktrees

The `worker` profile commits changes to `pi-subagent-<runId>` branches and **removes the temp worktree** afterward. Branches remain for you to merge. `/agents` lists branches; `session_shutdown` runs `git worktree prune` in the repo.

## Settings (`~/.pi/agent/settings.json` or `.pi/settings.json`)

```json
{
  "subagents": {
    "defaultTimeoutMs": 600000,
    "sessionSoftCostUsd": 5,
    "agentOverrides": {
      "scout": { "thinking": "high" }
    }
  }
}
```

Profile frontmatter supports `tools: *` (all built-in tools) and infers `shared-write` when write tools are declared without an explicit `workspace`.

## Development

From the monorepo:

```bash
npm test -w pi-tian-subagents
pi -e ./packages/pi-subagents
```
