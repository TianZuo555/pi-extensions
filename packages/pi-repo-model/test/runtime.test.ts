import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRepoModelRuntime, RepoModelRuntime, runRepoModel } from "../src/runtime.ts";

// git exports GIT_DIR (and friends) to hook subprocesses, and lefthook's
// pre-push passes them through to `pnpm test`. Left in place, they redirect
// every git invocation — including repo-registry's own rev-parse — to the
// repository being pushed instead of these fixtures. Delete them so git
// resolves from the working directory again (see pi-commit/test/git-env.ts
// for the incident this class of leak caused).
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
] as const) {
  delete process.env[key];
}

test("RepoModelRuntime getRepoMeta resolves directory metadata", async () => {
  const runtime = createRepoModelRuntime();
  const service = runtime.runSync(RepoModelRuntime);

  const cwd = process.cwd();
  const meta = await runRepoModel(runtime, service.getRepoMeta(cwd));
  assert.ok(meta.key);
  assert.ok(meta.name);

  await runtime.dispose();
});

test("RepoModelRuntime preserves spaces in Git worktree paths", async () => {
  const runtime = createRepoModelRuntime();
  const service = runtime.runSync(RepoModelRuntime);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-model-space-test-"));
  const repoDir = path.join(tempDir, "repo with spaces");

  try {
    execFileSync("git", ["init", "--quiet", repoDir]);
    const meta = await runRepoModel(runtime, service.getRepoMeta(repoDir));
    // The runtime canonicalizes through `realpathSync.native`, which also expands
    // Windows 8.3 short names (`RUNNER~1`) that the JS `realpathSync` keeps.
    assert.equal(meta.key, fs.realpathSync.native(repoDir));
    assert.equal(meta.name, "repo with spaces");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    await runtime.dispose();
  }
});

test("RepoModelRuntime set, get, unset, and list", async () => {
  const runtime = createRepoModelRuntime();
  const service = runtime.runSync(RepoModelRuntime);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repo-model-test-"));
  try {
    const initial = await runRepoModel(runtime, service.getRepoModel(tempDir));
    assert.equal(initial, undefined);

    await runRepoModel(
      runtime,
      service.setRepoModel(tempDir, {
        provider: "anthropic",
        model: "claude-sonnet",
        thinkingLevel: "high",
      }),
    );

    const saved = await runRepoModel(runtime, service.getRepoModel(tempDir));
    assert.ok(saved);
    assert.equal(saved.provider, "anthropic");
    assert.equal(saved.model, "claude-sonnet");
    assert.equal(saved.thinkingLevel, "high");

    const list = await runRepoModel(runtime, service.listRepos);
    assert.ok(list.some((item) => item.path === tempDir));

    const unsetRes = await runRepoModel(runtime, service.unsetRepoModel(tempDir));
    assert.equal(unsetRes.removed, true);

    const afterUnset = await runRepoModel(runtime, service.getRepoModel(tempDir));
    assert.equal(afterUnset, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    await runtime.dispose();
  }
});
