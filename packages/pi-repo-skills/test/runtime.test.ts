import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { ALL, createRepoSkillsRuntime, RepoSkillsRuntime, runRepoSkills } from "../src/runtime.ts";

test("RepoSkillsRuntime preserves spaces in Git worktree paths", async () => {
  const runtime = createRepoSkillsRuntime();
  const service = runtime.runSync(RepoSkillsRuntime);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-skills-space-test-"));
  const repoDir = path.join(tempDir, "repo with spaces");

  try {
    execFileSync("git", ["init", "--quiet", repoDir]);
    const meta = await runRepoSkills(runtime, service.getRepoMeta(repoDir));
    // The runtime canonicalizes through `realpathSync.native`, which also expands
    // Windows 8.3 short names (`RUNNER~1`) that the JS `realpathSync` keeps.
    assert.equal(meta.key, fs.realpathSync.native(repoDir));
    assert.equal(meta.name, "repo with spaces");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    await runtime.dispose();
  }
});

test("RepoSkillsRuntime set, get, filter, and reset", async () => {
  const runtime = createRepoSkillsRuntime();
  const service = runtime.runSync(RepoSkillsRuntime);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-skills-test-"));
  try {
    const initial = await runRepoSkills(runtime, service.getRepoSkills(tempDir));
    assert.equal(initial, undefined);

    const skills = [
      {
        name: "jira-cli",
        description: "Jira tool",
        filePath: "/tmp/jira.md",
        baseDir: "/tmp",
        disableModelInvocation: false,
      } as unknown as Skill,
      {
        name: "playwriter",
        description: "Browser tool",
        filePath: "/tmp/pw.md",
        baseDir: "/tmp",
        disableModelInvocation: false,
      } as unknown as Skill,
      {
        name: "git-helper",
        description: "Git tool",
        filePath: "/tmp/git.md",
        baseDir: "/tmp",
        disableModelInvocation: false,
      } as unknown as Skill,
    ];

    // Disable jira-cli
    await runRepoSkills(runtime, service.setRepoSkills(tempDir, ["jira-cli"]));

    const saved = await runRepoSkills(runtime, service.getRepoSkills(tempDir));
    assert.ok(saved);
    assert.deepEqual(saved.disabled, ["jira-cli"]);

    const filtered = await runRepoSkills(runtime, service.filterSkills(skills, tempDir));
    assert.equal(filtered.disabledCount, 1);
    assert.equal(filtered.enabled.length, 2);
    assert.deepEqual(
      filtered.enabled.map((s) => s.name),
      ["playwriter", "git-helper"],
    );

    // Disable ALL
    await runRepoSkills(runtime, service.setRepoSkills(tempDir, ALL));
    const allFiltered = await runRepoSkills(runtime, service.filterSkills(skills, tempDir));
    assert.equal(allFiltered.disabledCount, 3);
    assert.equal(allFiltered.enabled.length, 0);

    // Reset
    const resetRes = await runRepoSkills(runtime, service.resetRepoSkills(tempDir));
    assert.equal(resetRes.removed, true);

    const afterReset = await runRepoSkills(runtime, service.getRepoSkills(tempDir));
    assert.equal(afterReset, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    await runtime.dispose();
  }
});
