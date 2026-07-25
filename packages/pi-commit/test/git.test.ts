import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import {
  commitWithMessage,
  NoStagedChangesError,
  openGitRepository,
  readLatestCommitSummary,
  readStagedSnapshot,
  RepositoryChangedError,
  stageAllChanges,
  verifyStagedSnapshot,
  type ExecFunction,
} from "../lib/git.ts";

const testExec: ExecFunction = (command, args, options) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options?.cwd,
        timeout: options?.timeout,
        signal: options?.signal,
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createRepository(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-commit-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  git(directory, ["init", "--quiet"]);
  git(directory, ["config", "user.name", "Pi Commit Test"]);
  git(directory, ["config", "user.email", "pi-commit@example.test"]);
  await writeFile(path.join(directory, "tracked.txt"), "initial\n", "utf8");
  git(directory, ["add", "tracked.txt"]);
  git(directory, ["commit", "--quiet", "-m", "initial commit"]);
  return directory;
}

test("staged snapshots exclude later unstaged edits and detect index changes", async (t) => {
  const directory = await createRepository(t);
  const tracked = path.join(directory, "tracked.txt");

  await writeFile(tracked, "initial\nstaged line\n", "utf8");
  git(directory, ["add", "tracked.txt"]);
  await writeFile(tracked, "initial\nstaged line\nunstaged line\n", "utf8");

  const repository = await openGitRepository(testExec, directory);
  const snapshot = await readStagedSnapshot(repository, 64 * 1024);
  assert.match(snapshot.patch, /\+staged line/);
  assert.doesNotMatch(snapshot.patch, /unstaged line/);
  await verifyStagedSnapshot(repository, snapshot);

  git(directory, ["add", "tracked.txt"]);
  await assert.rejects(
    verifyStagedSnapshot(repository, snapshot),
    (error) => error instanceof RepositoryChangedError,
  );
});

test("snapshot creation rejects a repository with no staged changes", async (t) => {
  const directory = await createRepository(t);
  await writeFile(path.join(directory, "tracked.txt"), "unstaged only\n", "utf8");

  const repository = await openGitRepository(testExec, directory);
  await assert.rejects(
    readStagedSnapshot(repository, 64 * 1024),
    (error) => error instanceof NoStagedChangesError,
  );
});

test("staged snapshots and commits work on an unborn branch", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-commit-unborn-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  git(directory, ["init", "--quiet"]);
  git(directory, ["config", "user.name", "Pi Commit Test"]);
  git(directory, ["config", "user.email", "pi-commit@example.test"]);
  await writeFile(path.join(directory, "first.txt"), "first commit\n", "utf8");
  git(directory, ["add", "first.txt"]);

  const repository = await openGitRepository(testExec, directory);
  const snapshot = await readStagedSnapshot(repository, 64 * 1024);
  assert.equal(snapshot.fingerprint.head, null);
  assert.match(snapshot.nameStatus, /A\s+first\.txt/);

  const result = await commitWithMessage(repository, "initial project files");
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readLatestCommitSummary(repository), /initial project files$/);
});

test("stage-all includes untracked files and commitWithMessage creates the reviewed commit", async (t) => {
  const directory = await createRepository(t);
  await writeFile(path.join(directory, "tracked.txt"), "changed\n", "utf8");
  await writeFile(path.join(directory, "new file.txt"), "new content\n", "utf8");

  const repository = await openGitRepository(testExec, directory);
  await stageAllChanges(repository);
  const snapshot = await readStagedSnapshot(repository, 64 * 1024);
  assert.match(snapshot.nameStatus, /M\s+tracked\.txt/);
  assert.match(snapshot.nameStatus, /A\s+new file\.txt/);

  const result = await commitWithMessage(
    repository,
    "test: commit every change\n\nExercise the explicit stage-all workflow.",
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readLatestCommitSummary(repository), /test: commit every change$/);
  assert.equal(git(directory, ["status", "--porcelain"]), "");
  assert.equal(await readFile(path.join(directory, "new file.txt"), "utf8"), "new content\n");
});
