/**
 * Git worktree isolation for writer profiles.
 * Worktree helpers adapted from tintinweb/pi-subagents (MIT).
 */

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { GIT_DEFAULT_TIMEOUT_MS, runGitBuffer, runGitText } from "./git-exec.ts";

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseSha: string;
  workPath: string;
  repoRoot: string;
}

export type PatchApplyStatus = "not-applied" | "applied" | "already-applied" | "failed";

export interface WorktreePatchArtifact {
  path: string;
  sha256: string;
  applyStatus: PatchApplyStatus;
}

export interface WorktreeDelivery {
  repoRoot: string;
  baseSha: string;
  branch?: string;
  retainedWorktreePath?: string;
  patch?: WorktreePatchArtifact;
  error?: string;
}

export interface WorktreeFinalizeResult {
  hasChanges: boolean;
  delivery: WorktreeDelivery;
}

export interface WorktreeFinalizeOptions {
  description: string;
  artifactRoot?: string;
  runId?: string;
}

const LOCAL_GIT_NAME = "pi-subagent";
const LOCAL_GIT_EMAIL = "pi-subagent@local";
const GIT_TIMEOUT_MS = GIT_DEFAULT_TIMEOUT_MS;
const PATCH_TIMEOUT_MS = 60_000;
const PATCH_MAX_BUFFER = 64 * 1024 * 1024;

/** Keep the most recent N worker run artifact directories under artifactRoot/runs/. */
export const PATCH_ARTIFACT_RETENTION_RUNS = 32;

type GitResult = { ok: true; out: string } | { ok: false; error: string };

function safeGitSync(args: string[], cwd: string): GitResult {
  try {
    const out = execFileSync("git", args, { cwd, stdio: "pipe", timeout: GIT_TIMEOUT_MS })
      .toString()
      .trim();
    return { ok: true, out };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

async function safeGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const out = await runGitText(args, cwd);
    return { ok: true, out };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

async function safeGitWithIdentity(args: string[], cwd: string): Promise<GitResult> {
  try {
    const out = await runGitText(
      ["-c", `user.name=${LOCAL_GIT_NAME}`, "-c", `user.email=${LOCAL_GIT_EMAIL}`, ...args],
      cwd,
    );
    return { ok: true, out };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function getDefaultArtifactRoot(): string {
  return join(getAgentDir(), "subagents");
}

/**
 * Delete older run artifact directories, keeping the most recent by mtime.
 * Best-effort only — failures are swallowed so pruning never breaks a run.
 */
export function pruneStalePatchArtifacts(
  artifactRoot: string,
  keepRecent = PATCH_ARTIFACT_RETENTION_RUNS,
): void {
  try {
    const runsDir = join(artifactRoot, "runs");
    if (!existsSync(runsDir)) return;

    const entries = readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dirPath = join(runsDir, entry.name);
        return { path: dirPath, mtimeMs: statSync(dirPath).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const entry of entries.slice(keepRecent)) {
      rmSync(entry.path, { recursive: true, force: true });
    }
  } catch {
    // Best-effort retention; never break supervisor startup or teardown.
  }
}

export function getRunArtifactDir(artifactRoot: string, runId: string): string {
  return join(artifactRoot, "runs", runId);
}

export function createWorktree(cwd: string, runId: string): WorktreeInfo | undefined {
  let baseSha: string;
  let subdir: string;
  let repoRoot: string;
  const inside = safeGitSync(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!inside.ok) return undefined;

  const head = safeGitSync(["rev-parse", "HEAD"], cwd);
  const root = safeGitSync(["rev-parse", "--show-toplevel"], cwd);
  if (!head.ok || !root.ok) return undefined;

  baseSha = head.out;
  repoRoot = root.out;
  try {
    subdir = relative(realpathSync(repoRoot), realpathSync(cwd));
  } catch {
    return undefined;
  }

  const branch = `pi-subagent-${runId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-subagent-${runId}-${suffix}`);

  const added = safeGitSync(["worktree", "add", "--detach", worktreePath, baseSha], repoRoot);
  if (!added.ok) return undefined;

  return {
    path: worktreePath,
    branch,
    baseSha,
    repoRoot,
    workPath: subdir ? join(worktreePath, subdir) : worktreePath,
  };
}

async function removeWorktreeRegistration(worktree: WorktreeInfo): Promise<GitResult> {
  if (!existsSync(worktree.path)) return { ok: true, out: "" };
  return safeGit(["worktree", "remove", "--force", worktree.path], worktree.repoRoot);
}

async function currentHeadSha(worktree: WorktreeInfo): Promise<GitResult> {
  return safeGit(["rev-parse", "HEAD"], worktree.workPath);
}

type PorcelainStatus =
  | { ok: true; dirty: boolean }
  | { ok: false; error: string };

async function readPorcelainStatus(worktree: WorktreeInfo): Promise<PorcelainStatus> {
  const status = await safeGit(["status", "--porcelain"], worktree.workPath);
  if (!status.ok) {
    return { ok: false, error: `status check failed: ${status.error}` };
  }
  return { ok: true, dirty: status.out.length > 0 };
}

function hasCommittedChanges(worktree: WorktreeInfo, headSha: string): boolean {
  return headSha !== worktree.baseSha;
}

function retainWorktree(
  delivery: WorktreeDelivery,
  worktree: WorktreeInfo,
  error: string,
): WorktreeFinalizeResult {
  delivery.error = delivery.error ? `${delivery.error}; ${error}` : error;
  delivery.retainedWorktreePath = worktree.path;
  return { hasChanges: true, delivery };
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  const result = await safeGit(["show-ref", "--verify", `refs/heads/${branch}`], repoRoot);
  return result.ok;
}

async function createRunBranch(worktree: WorktreeInfo): Promise<GitResult> {
  if (await branchExists(worktree.repoRoot, worktree.branch)) {
    return { ok: false, error: `branch ${worktree.branch} already exists` };
  }
  return safeGit(["branch", worktree.branch], worktree.workPath);
}

export async function generatePatchFromBranch(
  repoRoot: string,
  baseSha: string,
  branch: string,
): Promise<Buffer> {
  return runGitBuffer(["diff", "--binary", `${baseSha}..${branch}`], repoRoot, {
    timeout: PATCH_TIMEOUT_MS,
    maxBuffer: PATCH_MAX_BUFFER,
  });
}

export async function writePatchArtifact(input: {
  runId: string;
  repoRoot: string;
  baseSha: string;
  branch: string;
  artifactRoot: string;
}): Promise<{ path: string; sha256: string } | { error: string }> {
  let tempPath: string | undefined;
  try {
    const patchBytes = await generatePatchFromBranch(input.repoRoot, input.baseSha, input.branch);
    ensurePrivateDir(input.artifactRoot);
    const runsDir = join(input.artifactRoot, "runs");
    ensurePrivateDir(runsDir);
    const runDir = getRunArtifactDir(input.artifactRoot, input.runId);
    ensurePrivateDir(runDir);

    const patchPath = join(runDir, "changes.patch");
    tempPath = `${patchPath}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tempPath, patchBytes, { mode: 0o600 });
    renameSync(tempPath, patchPath);
    tempPath = undefined;
    chmodSync(patchPath, 0o600);

    const sha256 = createHash("sha256").update(patchBytes).digest("hex");
    return { path: patchPath, sha256 };
  } catch (error) {
    if (tempPath && existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup.
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return { error: `patch generation failed: ${message}` };
  }
}

export async function finalizeWorktree(
  worktree: WorktreeInfo,
  options: WorktreeFinalizeOptions,
): Promise<WorktreeFinalizeResult> {
  const delivery: WorktreeDelivery = {
    repoRoot: worktree.repoRoot,
    baseSha: worktree.baseSha,
  };

  try {
    if (!existsSync(worktree.path)) {
      return { hasChanges: false, delivery };
    }

    const head = await currentHeadSha(worktree);
    if (!head.ok) {
      return retainWorktree(delivery, worktree, "could not resolve worktree HEAD");
    }

    const porcelainBefore = await readPorcelainStatus(worktree);
    if (!porcelainBefore.ok) {
      return retainWorktree(delivery, worktree, porcelainBefore.error);
    }

    const committed = hasCommittedChanges(worktree, head.out);
    const dirty = porcelainBefore.dirty;

    if (!committed && !dirty) {
      const removed = await removeWorktreeRegistration(worktree);
      if (!removed.ok) {
        return retainWorktree(delivery, worktree, `worktree removal failed: ${removed.error}`);
      }
      return { hasChanges: false, delivery };
    }

    if (dirty) {
      const add = await safeGit(["add", "-A"], worktree.workPath);
      if (!add.ok) {
        return retainWorktree(delivery, worktree, add.error);
      }
      const safeDesc = options.description.slice(0, 200);
      const commit = await safeGitWithIdentity(
        ["commit", "--no-verify", "-m", `pi-subagent: ${safeDesc}`],
        worktree.workPath,
      );
      if (!commit.ok) {
        return retainWorktree(delivery, worktree, commit.error);
      }
    }

    const headAfter = await currentHeadSha(worktree);
    if (!headAfter.ok) {
      return retainWorktree(delivery, worktree, "could not resolve worktree HEAD after commit");
    }

    const porcelainAfter = await readPorcelainStatus(worktree);
    if (!porcelainAfter.ok) {
      return retainWorktree(delivery, worktree, porcelainAfter.error);
    }

    if (!hasCommittedChanges(worktree, headAfter.out) && !porcelainAfter.dirty) {
      const removed = await removeWorktreeRegistration(worktree);
      if (!removed.ok) {
        return retainWorktree(delivery, worktree, `worktree removal failed: ${removed.error}`);
      }
      return { hasChanges: false, delivery };
    }

    const branch = await createRunBranch(worktree);
    if (!branch.ok) {
      return retainWorktree(delivery, worktree, branch.error);
    }
    delivery.branch = worktree.branch;

    if (options.runId && options.artifactRoot) {
      const patchResult = await writePatchArtifact({
        runId: options.runId,
        repoRoot: worktree.repoRoot,
        baseSha: worktree.baseSha,
        branch: worktree.branch,
        artifactRoot: options.artifactRoot,
      });
      if ("error" in patchResult) {
        return retainWorktree(delivery, worktree, patchResult.error);
      }
      delivery.patch = {
        path: patchResult.path,
        sha256: patchResult.sha256,
        applyStatus: "not-applied",
      };
    }

    const removed = await removeWorktreeRegistration(worktree);
    if (!removed.ok) {
      return retainWorktree(delivery, worktree, `worktree removal failed: ${removed.error}`);
    }
    return { hasChanges: true, delivery };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retainWorktree(delivery, worktree, message);
  }
}

/** Drop stale worktree registrations after session shutdown or crash recovery. */
export function pruneStaleWorktrees(repoCwd: string): void {
  safeGitSync(["worktree", "prune"], repoCwd);
}
