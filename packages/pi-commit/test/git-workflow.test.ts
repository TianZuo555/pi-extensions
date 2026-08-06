import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import {
  commitPlannedChangesEffect,
  openRepositoryEffect,
  readStagedSnapshotEffect,
  stageAllChangesEffect,
  type PlannedCommitResult,
} from "../src/git-workflow.ts";
import { createCommitRuntime, runCommit } from "../src/runtime.ts";

const testExec = (command: string, args: string[], options?: { cwd?: string }) =>
  new Promise<ExecResult>((resolve) => {
    import("node:child_process").then(({ execFile }) => {
      execFile(
        command,
        args,
        {
          cwd: options?.cwd,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const rawCode = error ? (error as NodeJS.ErrnoException).code : 0;
          const code = typeof rawCode === "number" ? rawCode : error ? 1 : 0;
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            code,
            killed: Boolean(error && "killed" in error && error.killed),
          });
        },
      );
    });
  });

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createRepository(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-commit-plan-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  git(directory, ["init", "--quiet"]);
  git(directory, ["config", "user.name", "Pi Commit Test"]);
  git(directory, ["config", "user.email", "pi-commit@example.test"]);
  await writeFile(path.join(directory, "alpha.txt"), "alpha\n", "utf8");
  await writeFile(path.join(directory, "beta.txt"), "beta\n", "utf8");
  git(directory, ["add", "alpha.txt", "beta.txt"]);
  return directory;
}

test("commitPlannedChangesEffect preserves summaries when a later commit fails", async (t) => {
  const directory = await createRepository(t);
  const runtime = createCommitRuntime();

  const repository = await runCommit(runtime, openRepositoryEffect(testExec, directory));
  await runCommit(runtime, stageAllChangesEffect(repository));
  const snapshot = await runCommit(runtime, readStagedSnapshotEffect(repository, 64 * 1024));

  const result = await runCommit(
    runtime,
    commitPlannedChangesEffect(repository, snapshot, {
      commits: [
        { paths: ["alpha.txt"], message: "feat: add alpha" },
        { paths: ["beta.txt"], message: "" },
      ],
    }),
  );

  await runtime.dispose();

  assert.equal(result.status, "error");
  const failure = result as Extract<PlannedCommitResult, { status: "error" }>;
  assert.equal(failure.summaries.length, 1);
  assert.match(failure.summaries[0]!, /feat: add alpha$/);
  assert.match(failure.error.message, /Creating commit 2|empty commit message/i);
});
