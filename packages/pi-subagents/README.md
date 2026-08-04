# pi-tian-subagents

Delegate bounded tasks to isolated Pi child processes from [pi](https://pi.dev).

```bash
pi install npm:pi-tian-subagents
```

## What it does

- **`subagent` tool** — spawn a profile-locked child `pi --mode rpc` process, return a bounded report with nested usage
- **Structured handoff** — children load a trusted `report_result` tool; missing/malformed reports fall back to bounded assistant text
- **Built-in profiles** — `scout`, `planner`, `reviewer`, `oracle` (read-only), `worker` (git worktree + writes)
- **Parallel runs** — call `subagent` multiple times in one turn (sibling tool calls)
- **Background mode** — `mode: "background"` returns immediately; completion arrives as a follow-up notification (exactly once)
- **`subagent_status` / `subagent_cancel` / `subagent_apply`** — poll, cancel, or explicitly apply a worker patch
- **`/agents` command** — list session runs and available profiles

Capabilities (model, tools, workspace, `maxTurns`) come from the profile — not from tool arguments.

## Profiles

Profiles live as Markdown with YAML frontmatter:

| Source | Location |
|---|---|
| Built-in | shipped in `profiles/` |
| User | `~/.pi/agent/agents/*.md` |
| Project | `.pi/agents/*.md` (requires trusted project + first-use approval by content hash) |

Reference profiles by short name (`scout`) or qualified id (`builtin/reviewer`, `project/my-agent`).

Supported frontmatter includes `tools`, `workspace`, `timeoutSeconds`, and `maxTurns` (default `8`).

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

Apply a worker patch after explicit confirmation:

```json
{
  "run_id": "sa-a13f9c2b"
}
```

Use the `subagent_apply` tool (not automatic for worker runs).

## Session limits

- Max **4** concurrent child processes
- Max **20** runs per parent session
- Profile `maxTurns` default **8** (soft live-turn boundary via RPC `turn_start`; a steer warning is injected on the final allowed turn before hard abort)
- Soft cost warning at 80% of session ceiling (default $5; override via `settings.json` → `subagents.sessionSoftCostUsd`)

## Child isolation

Children use `--no-extensions` (no extension MCP servers), `--no-skills`, and related flags. The supervisor loads only the package-owned child runtime explicitly via `-e <package>/lib/child-runtime.ts`, which registers `report_result`. Pi has no built-in MCP; `process.env` is inherited for API keys.

## Worktrees and patches

The `worker` profile commits changes to `pi-subagent-<runId>` branches, writes a private persistent patch artifact under `~/.pi/agent/subagents/runs/<runId>/changes.patch`, and removes the temp worktree only after the branch and patch are durable. Applying changes to the parent checkout requires `subagent_apply` with interactive confirmation.

### Patch artifact storage and security

Machine-local subagent state lives under `~/.pi/agent/subagents/`:

| Path | Contents |
|---|---|
| `approvals.json` | Project profile trust hashes |
| `runs/<runId>/changes.patch` | Binary-capable worker diff (up to 64MB per patch) |

Patch artifacts are written with `0600` files inside `0700` directories. Each patch is a full `git diff --binary` from the run baseline and **may contain secrets** (for example `.env` edits or API keys). Artifacts are **not** pruned per-run; the supervisor keeps the **32** most recent `runs/<runId>/` directories (by modification time) on session start and dispose. Older directories are deleted best-effort and pruning failures never block a run.

To reclaim disk space manually:

```bash
rm -rf ~/.pi/agent/subagents/runs/<runId>
# or remove the entire runs tree:
rm -rf ~/.pi/agent/subagents/runs
```

## Settings (`~/.pi/agent/settings.json` or `.pi/settings.json`)

```json
{
  "subagents": {
    "defaultTimeoutMs": 600000,
    "defaultMaxTurns": 8,
    "sessionSoftCostUsd": 5,
    "agentOverrides": {
      "scout": { "thinking": "high", "maxTurns": 6 }
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
