import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRepoModelRuntime,
  RepoModelRuntime,
  runRepoModel,
} from "../src/runtime.ts";

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
    assert.equal(meta.key, fs.realpathSync(repoDir));
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
