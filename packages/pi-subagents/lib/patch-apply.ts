/**
 * Verified patch application to the parent checkout.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { GIT_DEFAULT_TIMEOUT_MS, runGitWithInput } from "./git-exec.ts";
import type { PatchApplyStatus, WorktreePatchArtifact } from "./worktree.ts";

export type PatchApplyOutcome =
  | { ok: true; status: Extract<PatchApplyStatus, "applied" | "already-applied"> }
  | { ok: false; status: Extract<PatchApplyStatus, "failed">; error: string };

export interface PatchApplyInput {
  repoRoot: string;
  patch: WorktreePatchArtifact;
}

async function gitApplyCheck(args: string[], cwd: string, patchBytes: Buffer): Promise<boolean> {
  try {
    await runGitWithInput(["apply", "--binary", ...args], cwd, patchBytes, GIT_DEFAULT_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

export function readVerifiedPatch(patch: WorktreePatchArtifact): Buffer {
  const bytes = readFileSync(patch.path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== patch.sha256) {
    throw new Error("patch SHA-256 mismatch — artifact may be tampered or stale");
  }
  return bytes;
}

async function classifyAndApply(
  applyForward: () => Promise<void>,
  reverseOk: boolean,
  forwardOk: boolean,
): Promise<PatchApplyOutcome> {
  if (reverseOk && !forwardOk) {
    return { ok: true, status: "already-applied" };
  }
  if (!reverseOk && forwardOk) {
    try {
      await applyForward();
      return { ok: true, status: "applied" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, status: "failed", error: message };
    }
  }
  if (reverseOk && forwardOk) {
    return {
      ok: false,
      status: "failed",
      error: "ambiguous patch state — both forward and reverse apply checks succeeded",
    };
  }
  return {
    ok: false,
    status: "failed",
    error: "patch does not apply cleanly to the current checkout",
  };
}

export async function applyVerifiedPatch(input: PatchApplyInput): Promise<PatchApplyOutcome> {
  let patchBytes: Buffer;
  try {
    patchBytes = readVerifiedPatch(input.patch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: "failed", error: message };
  }

  const reverseOk = await gitApplyCheck(["--check", "--reverse", "-"], input.repoRoot, patchBytes);
  const forwardOk = await gitApplyCheck(["--check", "-"], input.repoRoot, patchBytes);

  return classifyAndApply(
    () => runGitWithInput(["apply", "--binary", "-"], input.repoRoot, patchBytes, GIT_DEFAULT_TIMEOUT_MS),
    reverseOk,
    forwardOk,
  );
}
