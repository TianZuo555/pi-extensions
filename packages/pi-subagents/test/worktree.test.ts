import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { cleanupWorktree, createWorktree, pruneStaleWorktrees } from "../lib/worktree.ts";

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

describe("worktree", () => {
  it("removes worktree after committing changes", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wt-"));
    initGitRepo(repo);

    const worktree = createWorktree(repo, "test-run");
    assert.ok(worktree);
    fs.writeFileSync(path.join(worktree!.workPath, "change.txt"), "hello\n", "utf8");

    const cleanup = cleanupWorktree(worktree!, "add change.txt");
    assert.equal(cleanup.hasChanges, true);
    assert.ok(cleanup.branch);
    assert.equal(fs.existsSync(worktree!.path), false);

    const list = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });
    assert.ok(!list.includes(worktree!.path));

    pruneStaleWorktrees(repo);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("removes clean worktree without branch", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wt-"));
    initGitRepo(repo);

    const worktree = createWorktree(repo, "clean-run");
    assert.ok(worktree);

    const cleanup = cleanupWorktree(worktree!, "no changes");
    assert.equal(cleanup.hasChanges, false);
    assert.equal(fs.existsSync(worktree!.path), false);

    fs.rmSync(repo, { recursive: true, force: true });
  });
});
