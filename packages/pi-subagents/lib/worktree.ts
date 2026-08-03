/**
 * Git worktree isolation for writer profiles.
 * Worktree helpers adapted from tintinweb/pi-subagents (MIT).
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseSha: string;
  workPath: string;
  repoRoot: string;
}

export interface WorktreeCleanupResult {
  hasChanges: boolean;
  branch?: string;
}

export function createWorktree(cwd: string, runId: string): WorktreeInfo | undefined {
  let baseSha: string;
  let subdir: string;
  let repoRoot: string;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe", timeout: 5000 });
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    subdir = relative(realpathSync(repoRoot), realpathSync(cwd));
  } catch {
    return undefined;
  }

  const branch = `pi-subagent-${runId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-subagent-${runId}-${suffix}`);

  try {
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd: repoRoot,
      stdio: "pipe",
      timeout: 30000,
    });
    return {
      path: worktreePath,
      branch,
      baseSha,
      repoRoot,
      workPath: subdir ? join(worktreePath, subdir) : worktreePath,
    };
  } catch {
    return undefined;
  }
}

function removeWorktreeRegistration(worktree: WorktreeInfo): void {
  if (!existsSync(worktree.path)) return;
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktree.path], {
      cwd: worktree.repoRoot,
      stdio: "pipe",
      timeout: 30000,
    });
  } catch {
    // Best-effort — path may already be gone.
  }
}

export function cleanupWorktree(
  worktree: WorktreeInfo,
  description: string,
): WorktreeCleanupResult {
  if (!existsSync(worktree.path)) return { hasChanges: false };

  let hasChanges = false;
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    })
      .toString()
      .trim();

    if (status) {
      execFileSync("git", ["checkout", "-B", worktree.branch], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 10000,
      });
      execFileSync("git", ["add", "-A"], { cwd: worktree.path, stdio: "pipe", timeout: 10000 });
      const safeDesc = description.slice(0, 200);
      execFileSync("git", ["commit", "--no-verify", "-m", `pi-subagent: ${safeDesc}`], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 10000,
      });
      hasChanges = true;
    }
  } catch {
    removeWorktreeRegistration(worktree);
    return { hasChanges: false };
  }

  removeWorktreeRegistration(worktree);
  return hasChanges ? { hasChanges: true, branch: worktree.branch } : { hasChanges: false };
}

/** Drop stale worktree registrations after session shutdown or crash recovery. */
export function pruneStaleWorktrees(repoCwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: repoCwd, stdio: "pipe", timeout: 10000 });
  } catch {
    // Not a git repo or prune failed.
  }
}
