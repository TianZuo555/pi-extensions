# pi-tian-subagents

Delegate bounded tasks to isolated subagent runs from [pi](https://pi.dev). Each profile can run on a **Herdr pane backend** (interactive agent CLIs in dedicated panes) or fall back to the legacy **RPC child backend** (`pi --mode rpc` headless children).

```bash
pi install npm:pi-tian-subagents
```

Requires a Herdr session (`HERDR_ENV=1` and `herdr` on PATH) for non-`pi` agent kinds and for profiles that pin `backend: herdr`. Built-in profiles default to `kind: pi` and `backend: auto`, so out-of-the-box behavior stays RPC-based when Herdr is not active.

## What it does

- **`subagent` tool** — spawn a profile-locked run and return a bounded report (structured when possible)
- **Dual backend** — Herdr when available and appropriate; RPC child otherwise (see Backend selection below)
- **Structured handoff** — Herdr runs use a file-based report contract; RPC runs use the `report_result` tool. Missing or invalid reports fall back to bounded transcript text
- **Built-in profiles** — `scout`, `planner`, `reviewer`, `oracle` (read-only), `worker` (git worktree + writes)
- **Parallel runs** — call `subagent` multiple times in one turn (sibling tool calls)
- **Background mode** — `mode: "background"` returns immediately; completion arrives as a follow-up notification (exactly once)
- **`subagent_status` / `subagent_cancel` / `subagent_apply`** — poll, cancel, or explicitly apply a worker patch
- **`/agents` command** — list session runs, Herdr pane metadata, and actions to focus a pane, read the last 80 transcript lines, or close a helper pane

Capabilities (`tools`, `workspace`) and the resolved model come from the profile — not from tool arguments.

## Backend selection

Resolved per run from profile frontmatter:

| `backend` | Behavior |
|---|---|
| `rpc` | Always use the RPC child backend |
| `herdr` | Always use Herdr; hard error if `HERDR_ENV !== 1` or `herdr` is not on PATH |
| `auto` (default) | Herdr when Herdr is available; otherwise RPC **only for `kind: pi`** |

If `backend: auto` (or implicit auto) and `kind` is not `pi` while Herdr is unavailable, the run **fails** with a clear error (for example: `Profile "x" requires agent kind "codex", which needs a Herdr session`). Non-`pi` kinds are never silently downgraded to a `pi` RPC child.

## Profile frontmatter

Profiles live as Markdown with YAML frontmatter:

| Field | Meaning |
|---|---|
| `kind` | Herdr agent kind (`pi`, `codex`, `cursor`, …). Default `pi` |
| `backend` | `auto`, `herdr`, or `rpc`. Default `auto` |
| `agentArgs` | Extra argv passed after `--` to the agent CLI (validated; no shell metacharacters) |
| `tools` | Tool allowlist for RPC runs; **advisory only** for Herdr runs (stated in the prompt, not enforced by the backend) |
| `workspace` | `shared-readonly`, `shared-write`, or `worktree` |
| `timeoutSeconds`, `maxTurns` | Wall-clock timeout; `maxTurns` is enforced only on the RPC backend |

| Source | Location |
|---|---|
| Built-in | shipped in `profiles/` |
| User | `~/.pi/agent/agents/*.md` |
| Project | `.pi/agents/*.md` (requires trusted project + first-use approval by content hash) |

Reference profiles by short name (`scout`) or qualified id (`builtin/reviewer`, `project/my-agent`).

Example user profile for a read-only Codex reviewer in Herdr:

```yaml
---
kind: codex
backend: herdr
tools: [read, grep]
workspace: shared-readonly
---
```

## Herdr runs — honest limits

Herdr-backed runs do **not** provide:

- **Usage / cost telemetry** — reports show `cost: n/a`; session cost warnings only count RPC usage
- **Per-tool allowlist enforcement** — only the RPC backend can enforce `--tools`; Herdr profiles should declare tools honestly in the prompt
- **`maxTurns` enforcement** — no `turn_start` signal; wall-clock `timeoutMs` only

`blocked` agent status is surfaced to the parent; the extension never auto-approves.

Worker isolation for write profiles uses `herdr worktree create` (branch checked out in a linked worktree). Patch generation, `0600`/`0700` artifacts, sha256 confirmation, and `subagent_apply` behave the same as RPC worktrees.

Helper panes and workspaces created by this session stay open for inspection until `/agents` closes them or the session shuts down.

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

- Max **4** concurrent runs (and concurrently open helper panes on Herdr)
- Max **20** runs per parent session
- Profile `maxTurns` default **8** — **RPC only** (soft live-turn boundary via `turn_start`)
- Soft cost warning at 80% of session ceiling (default $5; RPC usage only; override via `settings.json` → `subagents.sessionSoftCostUsd`)

## RPC child isolation

RPC children use `--no-extensions`, `--no-skills`, and related flags. The supervisor loads only the package-owned child runtime via `-e <package>/lib/child-runtime.ts`, which registers `report_result`.

## Worktrees and patches

The `worker` profile commits changes to `pi-subagent-<runId>` branches, writes a private persistent patch artifact under `~/.pi/agent/subagents/runs/<runId>/changes.patch`, and removes the temp worktree (or Herdr workspace) only after the branch and patch are durable. Applying changes to the parent checkout requires `subagent_apply` with interactive confirmation.

### Patch artifact storage and security

Machine-local subagent state lives under `~/.pi/agent/subagents/`:

| Path | Contents |
|---|---|
| `approvals.json` | Project profile trust hashes |
| `runs/<runId>/changes.patch` | Binary-capable worker diff (up to 64MB per patch) |
| `runs/<runId>/report.json` | Herdr structured report drop (when used) |

Patch artifacts are written with `0600` files inside `0700` directories. Each patch is a full `git diff --binary` from the run baseline and **may contain secrets**. The supervisor keeps the **32** most recent `runs/<runId>/` directories (by modification time) on session start and dispose.

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

## Development

From the monorepo:

```bash
pnpm --filter pi-tian-subagents run check
pnpm --filter pi-tian-subagents test
pi -e ./packages/pi-subagents
```

Set `HERDR_ENV=1` and ensure a fake or real `herdr` binary is on PATH when exercising Herdr-backed profiles locally.
