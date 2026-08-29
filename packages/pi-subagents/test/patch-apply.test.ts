import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  applyVerifiedPatch,
  readVerifiedPatch,
  type PatchApplyOutcome,
} from "../lib/patch-apply.ts";
import { finalizeWorktree, createWorktree } from "../lib/worktree.ts";
import { SubagentSupervisor } from "../lib/supervisor.ts";
import { hermeticGitProcessEnv } from "./git-env.ts";

hermeticGitProcessEnv();

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-rpc-child.mjs",
);

const fakeModel = {
  provider: "openai",
  id: "gpt-4.1-mini",
} as import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "pi-subagents test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "pi-subagents-test@example.invalid"], {
    cwd: dir,
    stdio: "pipe",
  });
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
}

function isolatedAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-apply-"));
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

function makePatch(repo: string, branch: string, baseSha: string): Buffer {
  return execFileSync("git", ["diff", "--binary", `${baseSha}..${branch}`], {
    cwd: repo,
    stdio: "pipe",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function applyPatchBytes(repo: string, patchBytes: Buffer): Promise<PatchApplyOutcome> {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-artifact-"));
  const patchPath = path.join(artifactDir, "changes.patch");
  fs.writeFileSync(patchPath, patchBytes);
  const sha256 = createHash("sha256").update(patchBytes).digest("hex");
  return applyVerifiedPatch({
    repoRoot: repo,
    patch: { path: patchPath, sha256, applyStatus: "not-applied" },
  }).finally(() => {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  });
}

function createFeatureBranch(repo: string, branch: string, baseSha: string): void {
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n", "utf8");
  execFileSync("git", ["checkout", "-B", branch], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["add", "feature.txt"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "feature"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["checkout", "-"], { cwd: repo, stdio: "pipe" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(head, baseSha);
}

describe("patch apply", () => {
  it("applies a forward-clean patch once", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-apply-repo-"));
    initGitRepo(repo);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const branch = "pi-subagent-test";
    createFeatureBranch(repo, branch, baseSha);

    const patchBytes = makePatch(repo, branch, baseSha);
    const outcome = await applyPatchBytes(repo, patchBytes);
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.status, "applied");
    assert.equal(fs.readFileSync(path.join(repo, "feature.txt"), "utf8"), "feature\n");

    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("returns already-applied on idempotent retry", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-apply-repo-"));
    initGitRepo(repo);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const branch = "pi-subagent-test";
    createFeatureBranch(repo, branch, baseSha);

    const patchBytes = makePatch(repo, branch, baseSha);
    const first = await applyPatchBytes(repo, patchBytes);
    const second = await applyPatchBytes(repo, patchBytes);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.status, "already-applied");

    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("refuses ambiguous patches without mutating checkout", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-apply-repo-"));
    initGitRepo(repo);
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    const patchBytes = Buffer.from("", "utf8");
    const outcome = await applyPatchBytes(repo, patchBytes);
    assert.equal(outcome.ok, false);
    const after = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.equal(before, after);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("rejects tampered artifacts by hash", () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-artifact-"));
    const patchPath = path.join(artifactDir, "changes.patch");
    fs.writeFileSync(patchPath, "diff --git a/x b/x\n", "utf8");
    assert.throws(
      () =>
        readVerifiedPatch({
          path: patchPath,
          sha256: "0".repeat(64),
          applyStatus: "not-applied",
        }),
      /SHA-256 mismatch/,
    );
    fs.rmSync(artifactDir, { recursive: true, force: true });
  });

  it("supervisor applyPatch records auditable status", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-apply-repo-"));
    initGitRepo(repo);
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-artifacts-"));
    const agentDir = isolatedAgentDir();

    const worktree = createWorktree(repo, "apply-run");
    assert.ok(worktree);
    fs.writeFileSync(path.join(worktree!.workPath, "worker.txt"), "worker\n", "utf8");
    const finalized = await finalizeWorktree(worktree!, {
      description: "worker change",
      runId: "apply-run",
      artifactRoot,
    });
    assert.ok(finalized.delivery.patch);

    const sv = new SubagentSupervisor(repo, agentDir, { artifactRoot });
    const record = {
      runId: "apply-run",
      profile: "worker",
      qualifiedProfile: "builtin/worker",
      status: "completed" as const,
      report: "done",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      durationMs: 1,
      worktreeBranch: finalized.delivery.branch,
      worktreeDelivery: finalized.delivery,
    };
    sv["runs"].register({
      runId: "apply-run",
      profile: "worker",
      qualifiedProfile: "builtin/worker",
      taskPreview: "worker change",
      mode: "foreground",
      abortController: new AbortController(),
    });
    sv["runs"].complete("apply-run", record);

    const applied = await sv.applyPatch("apply-run");
    assert.equal(applied.worktreeDelivery?.patch?.applyStatus, "applied");
    assert.equal(fs.readFileSync(path.join(repo, "worker.txt"), "utf8"), "worker\n");

    const replay = await sv.applyPatch("apply-run");
    assert.equal(replay.worktreeDelivery?.patch?.applyStatus, "already-applied");

    await sv.dispose();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("applies when parent has unrelated dirty files", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-apply-repo-"));
    initGitRepo(repo);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const branch = "pi-subagent-dirty";
    createFeatureBranch(repo, branch, baseSha);

    fs.writeFileSync(path.join(repo, "dirty-local.txt"), "local edits\n", "utf8");

    const patchBytes = makePatch(repo, branch, baseSha);
    const outcome = await applyPatchBytes(repo, patchBytes);
    assert.equal(outcome.ok, true);
    assert.equal(fs.readFileSync(path.join(repo, "feature.txt"), "utf8"), "feature\n");
    assert.equal(fs.readFileSync(path.join(repo, "dirty-local.txt"), "utf8"), "local edits\n");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    assert.match(status, /dirty-local\.txt/);
    assert.doesNotMatch(status, /^M /m);

    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("applies when parent HEAD moved without conflicting files", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-apply-repo-"));
    initGitRepo(repo);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const branch = "pi-subagent-head";
    createFeatureBranch(repo, branch, baseSha);

    const patchBytes = makePatch(repo, branch, baseSha);
    fs.writeFileSync(path.join(repo, "README.md"), "parent moved on\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "parent moved"], { cwd: repo, stdio: "pipe" });

    const outcome = await applyPatchBytes(repo, patchBytes);
    assert.equal(outcome.ok, true);
    assert.equal(fs.readFileSync(path.join(repo, "feature.txt"), "utf8"), "feature\n");

    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("fails on conflicting changed HEAD without mutating checkout", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-apply-repo-"));
    initGitRepo(repo);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const branch = "pi-subagent-conflict";
    createFeatureBranch(repo, branch, baseSha);

    const patchBytes = makePatch(repo, branch, baseSha);
    fs.writeFileSync(path.join(repo, "feature.txt"), "parent conflict\n", "utf8");
    execFileSync("git", ["add", "feature.txt"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "parent conflict"], { cwd: repo, stdio: "pipe" });
    const before = execFileSync("git", ["show", "-s", "--format=%H", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    const outcome = await applyPatchBytes(repo, patchBytes);
    assert.equal(outcome.ok, false);
    const after = execFileSync("git", ["show", "-s", "--format=%H", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    assert.equal(after, before);
    assert.equal(fs.readFileSync(path.join(repo, "feature.txt"), "utf8"), "parent conflict\n");

    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("records failed apply on both run record and result", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-apply-repo-"));
    initGitRepo(repo);
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-artifacts-"));
    const agentDir = isolatedAgentDir();
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const sourceBranch = "pi-subagent-source";
    createFeatureBranch(repo, sourceBranch, baseSha);

    const worktree = createWorktree(repo, "fail-apply");
    assert.ok(worktree);
    fs.writeFileSync(path.join(worktree!.workPath, "feature.txt"), "worker feature\n", "utf8");
    const finalized = await finalizeWorktree(worktree!, {
      description: "worker change",
      runId: "fail-apply",
      artifactRoot,
    });
    assert.ok(finalized.delivery.patch);

    fs.writeFileSync(path.join(repo, "feature.txt"), "parent conflict\n", "utf8");
    execFileSync("git", ["add", "feature.txt"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "parent conflict"], { cwd: repo, stdio: "pipe" });

    const sv = new SubagentSupervisor(repo, agentDir, { artifactRoot });
    const record = {
      runId: "fail-apply",
      profile: "worker",
      qualifiedProfile: "builtin/worker",
      status: "failed" as const,
      report: "done",
      error: "prior run failure",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      durationMs: 1,
      worktreeBranch: finalized.delivery.branch,
      worktreeDelivery: finalized.delivery,
    };
    sv["runs"].register({
      runId: "fail-apply",
      profile: "worker",
      qualifiedProfile: "builtin/worker",
      taskPreview: "worker change",
      mode: "foreground",
      abortController: new AbortController(),
    });
    sv["runs"].complete("fail-apply", record);

    await assert.rejects(() => sv.applyPatch("fail-apply"));
    const stored = sv.getRun("fail-apply");
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.result?.status, "failed");
    assert.match(stored?.result?.error ?? "", /prior run failure/);
    assert.match(stored?.result?.error ?? "", /patch does not apply|does not apply cleanly/i);
    assert.equal(stored?.result?.worktreeDelivery?.patch?.applyStatus, "failed");
    assert.equal(stored?.worktreeDelivery?.patch?.applyStatus, "failed");

    await sv.dispose();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("supports binary patch content", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-apply-repo-"));
    initGitRepo(repo);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const branch = "pi-subagent-binary";
    const binary = Buffer.from([0, 1, 2, 3, 255, 254]);
    fs.writeFileSync(path.join(repo, "binary.bin"), binary);
    execFileSync("git", ["checkout", "-B", branch], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["add", "binary.bin"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "binary"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["checkout", "-"], { cwd: repo, stdio: "pipe" });

    const patchBytes = makePatch(repo, branch, baseSha);
    const outcome = await applyPatchBytes(repo, patchBytes);
    assert.equal(outcome.ok, true);
    assert.deepEqual(fs.readFileSync(path.join(repo, "binary.bin")), binary);

    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("verifies stored artifact hash before apply", () => {
    const bytes = Buffer.from("diff --git a/a.txt b/a.txt\n", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-artifact-"));
    const patchPath = path.join(dir, "changes.patch");
    fs.writeFileSync(patchPath, bytes);
    const verified = readVerifiedPatch({
      path: patchPath,
      sha256,
      applyStatus: "not-applied",
    });
    assert.deepEqual(verified, bytes);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
