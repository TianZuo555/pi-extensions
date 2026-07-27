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
  pushCurrentBranch,
  readDefaultRemote,
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

async function createBareRemote(t: TestContext): Promise<string> {
  const remoteDir = await mkdtemp(path.join(os.tmpdir(), "pi-commit-remote-"));
  t.after(async () => rm(remoteDir, { recursive: true, force: true }));
  git(remoteDir, ["init", "--quiet", "--bare"]);
  return remoteDir;
}

test("readDefaultRemote prefers origin over other remotes", async (t) => {
  const directory = await createRepository(t);
  const remoteA = await createBareRemote(t);
  const remoteB = await createBareRemote(t);
  git(directory, ["remote", "add", "upstream", remoteA]);
  git(directory, ["remote", "add", "origin", remoteB]);

  const repository = await openGitRepository(testExec, directory);
  assert.equal(await readDefaultRemote(repository), "origin");
});

test("pushCurrentBranch sets upstream on the first push and pushes afterwards", async (t) => {
  const directory = await createRepository(t);
  git(directory, ["branch", "-M", "main"]);
  const remoteDir = await createBareRemote(t);
  git(directory, ["remote", "add", "origin", remoteDir]);

  await writeFile(path.join(directory, "tracked.txt"), "changed\n", "utf8");
  git(directory, ["add", "tracked.txt"]);

  const repository = await openGitRepository(testExec, directory);
  const commitResult = await commitWithMessage(repository, "change for push");
  assert.equal(commitResult.code, 0, commitResult.stderr);

  const firstPush = await pushCurrentBranch(repository);
  assert.equal(firstPush.code, 0, firstPush.stderr);
  assert.equal(
    git(directory, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
    "origin/main",
  );
  assert.equal(
    git(remoteDir, ["log", "-1", "--pretty=format:%s", "refs/heads/main"]),
    "change for push",
  );

  // A second push has an upstream configured, so it runs a plain `git push`.
  await writeFile(path.join(directory, "tracked.txt"), "changed again\n", "utf8");
  git(directory, ["add", "tracked.txt"]);
  const secondCommit = await commitWithMessage(repository, "second change");
  assert.equal(secondCommit.code, 0, secondCommit.stderr);

  const secondPush = await pushCurrentBranch(repository);
  assert.equal(secondPush.code, 0, secondPush.stderr);
  assert.equal(
    git(remoteDir, ["log", "-1", "--pretty=format:%s", "refs/heads/main"]),
    "second change",
  );
});

test("pushCurrentBranch targets the only configured remote when origin is absent", async (t) => {
  const directory = await createRepository(t);
  git(directory, ["branch", "-M", "feature"]);
  const remoteDir = await createBareRemote(t);
  git(directory, ["remote", "add", "company", remoteDir]);

  await writeFile(path.join(directory, "tracked.txt"), "changed\n", "utf8");
  git(directory, ["add", "tracked.txt"]);

  const repository = await openGitRepository(testExec, directory);
  const commitResult = await commitWithMessage(repository, "feature change");
  assert.equal(commitResult.code, 0, commitResult.stderr);

  const pushResult = await pushCurrentBranch(repository);
  assert.equal(pushResult.code, 0, pushResult.stderr);
  assert.equal(
    git(directory, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
    "company/feature",
  );
});
