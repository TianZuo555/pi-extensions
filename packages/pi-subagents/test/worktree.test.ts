import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import {
  finalizeWorktree,
  createWorktree,
  pruneStalePatchArtifacts,
  pruneStaleWorktrees,
  writePatchArtifact,
  PATCH_ARTIFACT_RETENTION_RUNS,
  type WorktreeInfo,
} from "../lib/worktree.ts";
import { assertPrivateMode, posixOnly } from "./platform.ts";
import { hermeticGitProcessEnv } from "./git-env.ts";

hermeticGitProcessEnv();

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-herdr.mjs",
);

function fakeCliOptions(): { command: string; argsPrefix: string[] } {
  return { command: process.execPath, argsPrefix: [FIXTURE] };
}

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const key of Object.keys(overrides)) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const artifactDirs: string[] = [];

function isolatedGitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    ...extra,
  };
}

function mkArtifactRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-artifacts-"));
  artifactDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (artifactDirs.length > 0) {
    const dir = artifactDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function initGitRepo(dir: string, withRepoIdentity = true): void {
  const env = isolatedGitEnv();
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe", env });
  // Windows CI runners default to core.autocrlf=true; keep fixtures byte-exact.
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir, stdio: "pipe", env });
  if (withRepoIdentity) {
    execFileSync("git", ["config", "user.name", "pi-subagents test"], {
      cwd: dir,
      stdio: "pipe",
      env,
    });
    execFileSync("git", ["config", "user.email", "pi-subagents-test@example.invalid"], {
      cwd: dir,
      stdio: "pipe",
      env,
    });
  }
  fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe", env });
  execFileSync(
    "git",
    ["-c", "user.name=repo-init", "-c", "user.email=repo-init@local", "commit", "-m", "init"],
    { cwd: dir, stdio: "pipe", env },
  );
}

describe("worktree finalization", () => {
  it("removes worktree after committing dirty uncommitted changes", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wt-"));
    initGitRepo(repo);

    const worktree = createWorktree(repo, "dirty-run");
    assert.ok(worktree);
    fs.writeFileSync(path.join(worktree!.workPath, "change.txt"), "hello\n", "utf8");

    const result = await finalizeWorktree(worktree!, {
      description: "add change.txt",
      runId: "dirty-run",
      artifactRoot: mkArtifactRoot(),
    });
    assert.equal(result.hasChanges, true);
    assert.ok(result.delivery.branch);
    assert.equal(fs.existsSync(worktree!.path), false);

    const list = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });
    assert.ok(!list.includes(worktree!.path));

    pruneStaleWorktrees(repo);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("preserves child-created commits with clean porcelain status", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wt-"));
    initGitRepo(repo);

    const worktree = createWorktree(repo, "commit-run");
    assert.ok(worktree);
    fs.writeFileSync(path.join(worktree!.workPath, "committed.txt"), "child commit\n", "utf8");
    execFileSync("git", ["add", "committed.txt"], { cwd: worktree!.workPath, stdio: "pipe" });
    execFileSync(
      "git",
      ["-c", "user.name=child", "-c", "user.email=child@local", "commit", "-m", "child work"],
      { cwd: worktree!.workPath, stdio: "pipe" },
    );

    const artifactRoot = mkArtifactRoot();
    const result = await finalizeWorktree(worktree!, {
      description: "child commit",
      runId: "commit-run",
      artifactRoot,
    });
    assert.equal(result.hasChanges, true);
    assert.equal(result.delivery.branch, worktree!.branch);
    assert.equal(fs.existsSync(worktree!.path), false);

    const diff = execFileSync(
      "git",
      ["diff", `${worktree!.baseSha}..${worktree!.branch}`, "--", "committed.txt"],
      { cwd: repo, encoding: "utf8" },
    );
    assert.match(diff, /child commit/);

    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("commits dirty changes without global git user configuration", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wt-"));
    initGitRepo(repo, false);

    const worktree = createWorktree(repo, "noid-run");
    assert.ok(worktree);
    fs.writeFileSync(path.join(worktree!.workPath, "no-user.txt"), "data\n", "utf8");

    const artifactRoot = mkArtifactRoot();
    const result = await finalizeWorktree(worktree!, {
      description: "missing global identity",
      runId: "noid-run",
      artifactRoot,
    });
    assert.equal(result.hasChanges, true);
    assert.ok(result.delivery.branch);
    assert.equal(fs.existsSync(worktree!.path), false);

    const author = execFileSync(
      "git",
      ["log", "-1", "--format=%an <%ae>", result.delivery.branch!],
      { cwd: repo, encoding: "utf8", env: isolatedGitEnv() },
    ).trim();
    assert.equal(author, "pi-subagent <pi-subagent@local>");

    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("retains recovery worktree when durable artifact write fails", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wt-"));
    initGitRepo(repo);

    const worktree = createWorktree(repo, "fail-run");
    assert.ok(worktree);
    fs.writeFileSync(path.join(worktree!.workPath, "keep.txt"), "keep me\n", "utf8");

    const artifactRoot = path.join(repo, "README.md");
    const result = await finalizeWorktree(worktree!, {
      description: "artifact failure",
      runId: "fail-run",
      artifactRoot,
    });
    assert.equal(result.hasChanges, true);
    assert.ok(result.delivery.error);
    assert.equal(result.delivery.branch, worktree!.branch);
    assert.equal(result.delivery.patch, undefined);
    assert.equal(result.delivery.retainedWorktreePath, worktree!.path);
    assert.equal(fs.existsSync(worktree!.path), true);

    execFileSync("git", ["worktree", "remove", "--force", worktree!.path], {
      cwd: repo,
      stdio: "pipe",
    });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("retains worktree and omits branch when run branch already exists", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wt-"));
    initGitRepo(repo);

    const worktree = createWorktree(repo, "collision-run");
    assert.ok(worktree);
    execFileSync("git", ["branch", worktree!.branch], { cwd: repo, stdio: "pipe" });
    fs.writeFileSync(path.join(worktree!.workPath, "collision.txt"), "collision\n", "utf8");

    const result = await finalizeWorktree(worktree!, {
      description: "branch collision",
      runId: "collision-run",
      artifactRoot: mkArtifactRoot(),
    });
    assert.equal(result.hasChanges, true);
    assert.ok(result.delivery.error);
    assert.equal(result.delivery.branch, undefined);
    assert.equal(result.delivery.retainedWorktreePath, worktree!.path);
    assert.equal(fs.existsSync(worktree!.path), true);

    execFileSync("git", ["worktree", "remove", "--force", worktree!.path], {
      cwd: repo,
      stdio: "pipe",
    });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("retains worktree when porcelain status cannot be determined", posixOnly, async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wt-"));
    initGitRepo(repo);

    const worktree = createWorktree(repo, "status-fail-run");
    assert.ok(worktree);
    fs.writeFileSync(path.join(worktree!.workPath, "committed.txt"), "committed\n", "utf8");
    execFileSync("git", ["add", "committed.txt"], { cwd: worktree!.workPath, stdio: "pipe" });
    execFileSync(
      "git",
      ["-c", "user.name=child", "-c", "user.email=child@local", "commit", "-m", "child work"],
      { cwd: worktree!.workPath, stdio: "pipe" },
    );
    fs.writeFileSync(path.join(worktree!.workPath, "dirty.txt"), "dirty\n", "utf8");

    const gitPointer = fs.readFileSync(path.join(worktree!.path, ".git"), "utf8").trim();
    const gitdir = gitPointer.replace(/^gitdir:\s*/, "");
    const indexPath = path.join(gitdir, "index");
    const indexBackup = fs.readFileSync(indexPath);
    fs.writeFileSync(indexPath, "corrupt-index");

    const result = await finalizeWorktree(worktree!, {
      description: "status failure",
      runId: "status-fail-run",
      artifactRoot: mkArtifactRoot(),
    });

    fs.writeFileSync(indexPath, indexBackup);

    assert.equal(result.hasChanges, true);
    assert.match(result.delivery.error ?? "", /status check failed/i);
    assert.equal(result.delivery.retainedWorktreePath, worktree!.path);
    assert.equal(fs.existsSync(worktree!.path), true);
    assert.equal(fs.readFileSync(path.join(worktree!.workPath, "dirty.txt"), "utf8"), "dirty\n");

    execFileSync("git", ["worktree", "remove", "--force", worktree!.path], {
      cwd: repo,
      stdio: "pipe",
    });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("removes clean unchanged worktree without branch", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wt-"));
    initGitRepo(repo);

    const worktree = createWorktree(repo, "clean-run");
    assert.ok(worktree);

    const result = await finalizeWorktree(worktree!, { description: "no changes" });
    assert.equal(result.hasChanges, false);
    assert.equal(fs.existsSync(worktree!.path), false);

    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("writes private persistent patch artifacts outside the repo", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wt-"));
    initGitRepo(repo);
    const artifactRoot = mkArtifactRoot();

    const worktree = createWorktree(repo, "patch-run");
    assert.ok(worktree);
    fs.writeFileSync(path.join(worktree!.workPath, "patch.txt"), "patch me\n", "utf8");

    const result = await finalizeWorktree(worktree!, {
      description: "patch artifact",
      runId: "patch-run",
      artifactRoot,
    });
    assert.ok(result.delivery.patch);
    assert.ok(result.delivery.patch!.path.startsWith(artifactRoot));
    assert.ok(!result.delivery.patch!.path.startsWith(repo));
    assertPrivateMode(result.delivery.patch!.path, 0o600);
    assertPrivateMode(path.dirname(result.delivery.patch!.path), 0o700);
    assertPrivateMode(path.join(artifactRoot, "runs"), 0o700);
    assertPrivateMode(artifactRoot, 0o700);

    const patch = await writePatchArtifact({
      runId: "patch-run-2",
      repoRoot: repo,
      baseSha: worktree!.baseSha,
      branch: result.delivery.branch!,
      artifactRoot,
    });
    assert.ok("path" in patch);

    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("prunes older patch artifact run directories beyond retention limit", () => {
    const artifactRoot = mkArtifactRoot();
    const runsDir = path.join(artifactRoot, "runs");
    fs.mkdirSync(runsDir, { recursive: true });

    const total = PATCH_ARTIFACT_RETENTION_RUNS + 5;
    for (let i = 0; i < total; i++) {
      const runDir = path.join(runsDir, `run-${String(i).padStart(3, "0")}`);
      fs.mkdirSync(runDir, { recursive: true });
      const patchPath = path.join(runDir, "changes.patch");
      fs.writeFileSync(patchPath, `patch-${i}\n`, "utf8");
      const ageMs = (total - i) * 60_000;
      const touched = Date.now() - ageMs;
      fs.utimesSync(runDir, touched / 1000, touched / 1000);
      fs.utimesSync(patchPath, touched / 1000, touched / 1000);
    }

    pruneStalePatchArtifacts(artifactRoot, PATCH_ARTIFACT_RETENTION_RUNS);

    const remaining = fs.readdirSync(runsDir);
    assert.equal(remaining.length, PATCH_ARTIFACT_RETENTION_RUNS);
    assert.ok(!remaining.includes("run-000"));
    assert.ok(remaining.includes(`run-${String(total - 1).padStart(3, "0")}`));
  });

  it("finalizes when Herdr already created the run branch", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wt-"));
    initGitRepo(repo);

    const worktree = createWorktree(repo, "herdr-branch-run");
    assert.ok(worktree);
    execFileSync("git", ["checkout", "-B", worktree!.branch], {
      cwd: worktree!.workPath,
      stdio: "pipe",
    });
    const herdrWorktree: WorktreeInfo = {
      ...worktree!,
      branchPreexisting: true,
      herdrWorkspaceId: "ws-herdr-test",
    };
    fs.writeFileSync(
      path.join(herdrWorktree.workPath, "herdr-change.txt"),
      "herdr branch\n",
      "utf8",
    );

    const artifactRoot = mkArtifactRoot();
    const removeLog = path.join(os.tmpdir(), `herdr-remove-log-${process.pid}`);
    try {
      await withEnv({ FAKE_HERDR_RECORD_REMOVE: removeLog }, async () => {
        const result = await finalizeWorktree(herdrWorktree, {
          description: "herdr preexisting branch",
          runId: "herdr-branch-run",
          artifactRoot,
          herdrCliOptions: fakeCliOptions(),
        });
        assert.equal(result.hasChanges, true);
        assert.equal(result.delivery.branch, herdrWorktree.branch);
        assert.ok(result.delivery.patch);
        const logged = JSON.parse(
          fs.readFileSync(removeLog, "utf8").trim().split("\n")[0],
        ) as string[];
        assert.deepEqual(logged.slice(-5), [
          "worktree",
          "remove",
          "--workspace",
          "ws-herdr-test",
          "--force",
        ]);
      });
    } finally {
      fs.rmSync(removeLog, { force: true });
      if (fs.existsSync(herdrWorktree.path)) {
        execFileSync("git", ["worktree", "remove", "--force", herdrWorktree.path], {
          cwd: repo,
          stdio: "pipe",
        });
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("records herdr worktree remove argv shape via stubbed CLI", async () => {
    const removeLog = path.join(os.tmpdir(), `herdr-remove-shape-${process.pid}`);
    try {
      await withEnv({ FAKE_HERDR_RECORD_REMOVE: removeLog }, async () => {
        const { removeHerdrWorktree } = await import("../lib/herdr/workspace.ts");
        const { Effect } = await import("effect");
        await Effect.runPromise(removeHerdrWorktree("ws-shape-test", fakeCliOptions()));
        const logged = JSON.parse(fs.readFileSync(removeLog, "utf8").trim()) as string[];
        assert.deepEqual(logged.slice(-5), [
          "worktree",
          "remove",
          "--workspace",
          "ws-shape-test",
          "--force",
        ]);
      });
    } finally {
      fs.rmSync(removeLog, { force: true });
    }
  });
});
