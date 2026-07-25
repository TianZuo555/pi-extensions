import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

const READ_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 120_000;
const ERROR_OUTPUT_BYTES = 8 * 1024;

export type ExecFunction = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export interface GitRepository {
  root: string;
  exec: ExecFunction;
}

export interface RepositoryFingerprint {
  head: string | null;
  tree: string;
}

export interface StagedSnapshot {
  branch: string;
  fingerprint: RepositoryFingerprint;
  nameStatus: string;
  stat: string;
  patch: string;
  patchBytes: number;
  omittedPatchBytes: number;
  recentCommitSubjects: string;
}

export class NoStagedChangesError extends Error {
  constructor() {
    super("No staged changes. Stage files first or use /commit-all.");
    this.name = "NoStagedChangesError";
  }
}

export class RepositoryChangedError extends Error {
  constructor() {
    super("The staged snapshot or HEAD changed while preparing the commit. Run the command again.");
    this.name = "RepositoryChangedError";
  }
}

function outputText(result: ExecResult): string {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
}

export function truncateUtf8(value: string, maxBytes: number): {
  text: string;
  totalBytes: number;
  omittedBytes: number;
} {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return { text: value, totalBytes: buffer.byteLength, omittedBytes: 0 };
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = Math.max(0, Math.min(maxBytes, buffer.byteLength));
  let text = "";
  while (end >= Math.max(0, maxBytes - 4)) {
    try {
      text = decoder.decode(buffer.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }

  return {
    text,
    totalBytes: buffer.byteLength,
    omittedBytes: buffer.byteLength - end,
  };
}

export function describeGitFailure(action: string, result: ExecResult): string {
  const detail = outputText(result);
  if (!detail) return `${action} failed with exit code ${result.code}`;
  const truncated = truncateUtf8(detail, ERROR_OUTPUT_BYTES);
  const suffix = truncated.omittedBytes > 0 ? `\n… ${truncated.omittedBytes} bytes omitted` : "";
  return `${action} failed with exit code ${result.code}:\n${truncated.text}${suffix}`;
}

async function runGit(
  repository: GitRepository,
  args: string[],
  timeout = READ_TIMEOUT_MS,
): Promise<ExecResult> {
  return repository.exec("git", args, { cwd: repository.root, timeout });
}

async function runGitOrThrow(
  repository: GitRepository,
  args: string[],
  action: string,
  timeout = READ_TIMEOUT_MS,
): Promise<string> {
  const result = await runGit(repository, args, timeout);
  if (result.code !== 0) throw new Error(describeGitFailure(action, result));
  return result.stdout.trimEnd();
}

export async function openGitRepository(exec: ExecFunction, cwd: string): Promise<GitRepository> {
  const result = await exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeout: READ_TIMEOUT_MS,
  });
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(describeGitFailure("Finding Git repository", result));
  }
  return { root: result.stdout.trim(), exec };
}

export async function hasWorkingTreeChanges(repository: GitRepository): Promise<boolean> {
  const output = await runGitOrThrow(
    repository,
    ["status", "--porcelain=v1", "--untracked-files=normal", "--"],
    "Reading Git status",
  );
  return output.length > 0;
}

export async function ensureNoUnmergedEntries(repository: GitRepository): Promise<void> {
  const output = await runGitOrThrow(
    repository,
    ["ls-files", "--unmerged"],
    "Checking merge conflicts",
  );
  if (output.trim()) {
    throw new Error("Resolve all merge conflicts before creating a commit.");
  }
}

export async function stageAllChanges(repository: GitRepository): Promise<void> {
  await runGitOrThrow(
    repository,
    ["add", "--all", "--"],
    "Staging all changes",
    MUTATION_TIMEOUT_MS,
  );
}

async function hasStagedChanges(repository: GitRepository): Promise<boolean> {
  const result = await runGit(
    repository,
    ["diff", "--cached", "--quiet", "--exit-code", "--"],
  );
  if (result.code === 0) return false;
  if (result.code === 1) return true;
  throw new Error(describeGitFailure("Checking staged changes", result));
}

async function readHead(repository: GitRepository): Promise<string | null> {
  const result = await runGit(repository, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (result.code === 0) return result.stdout.trim();
  if (result.code === 1) return null;
  throw new Error(describeGitFailure("Reading HEAD", result));
}

async function readFingerprint(repository: GitRepository): Promise<RepositoryFingerprint> {
  const [head, tree] = await Promise.all([
    readHead(repository),
    runGitOrThrow(repository, ["write-tree"], "Reading staged tree"),
  ]);
  return { head, tree: tree.trim() };
}

function sameFingerprint(left: RepositoryFingerprint, right: RepositoryFingerprint): boolean {
  return left.head === right.head && left.tree === right.tree;
}

async function readRecentSubjects(repository: GitRepository): Promise<string> {
  const result = await runGit(repository, ["log", "-10", "--pretty=format:%s"]);
  if (result.code === 0) return result.stdout.trimEnd();
  if (result.code === 128) return "";
  throw new Error(describeGitFailure("Reading recent commits", result));
}

async function readBranch(repository: GitRepository): Promise<string> {
  const result = await runGit(repository, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  if (result.code === 1) return "(detached HEAD)";
  throw new Error(describeGitFailure("Reading current branch", result));
}

const DIFF_BASE_ARGS = [
  "diff",
  "--cached",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--find-renames",
  "--submodule=short",
] as const;

export async function readStagedSnapshot(
  repository: GitRepository,
  maxPatchBytes: number,
): Promise<StagedSnapshot> {
  await ensureNoUnmergedEntries(repository);
  if (!(await hasStagedChanges(repository))) throw new NoStagedChangesError();

  const fingerprint = await readFingerprint(repository);
  const [branch, nameStatus, stat, patch, recentCommitSubjects] = await Promise.all([
    readBranch(repository),
    runGitOrThrow(repository, [...DIFF_BASE_ARGS, "--name-status", "--"], "Reading staged file list"),
    runGitOrThrow(repository, [...DIFF_BASE_ARGS, "--stat", "--"], "Reading staged diff stat"),
    runGitOrThrow(repository, [...DIFF_BASE_ARGS, "--patch", "--"], "Reading staged patch"),
    readRecentSubjects(repository),
  ]);

  const afterRead = await readFingerprint(repository);
  if (!sameFingerprint(fingerprint, afterRead)) throw new RepositoryChangedError();

  const truncatedPatch = truncateUtf8(patch, maxPatchBytes);
  return {
    branch,
    fingerprint,
    nameStatus,
    stat,
    patch: truncatedPatch.text,
    patchBytes: truncatedPatch.totalBytes,
    omittedPatchBytes: truncatedPatch.omittedBytes,
    recentCommitSubjects,
  };
}

export async function verifyStagedSnapshot(
  repository: GitRepository,
  snapshot: StagedSnapshot,
): Promise<void> {
  await ensureNoUnmergedEntries(repository);
  const current = await readFingerprint(repository);
  if (!sameFingerprint(snapshot.fingerprint, current)) throw new RepositoryChangedError();
}

export async function commitWithMessage(
  repository: GitRepository,
  message: string,
): Promise<ExecResult> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-commit-"));
  const messageFile = path.join(directory, "message.txt");
  try {
    await writeFile(messageFile, `${message.trim()}\n`, { encoding: "utf8", mode: 0o600 });
    return await runGit(
      repository,
      ["commit", "--file", messageFile, "--cleanup=strip"],
      MUTATION_TIMEOUT_MS,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function readLatestCommitSummary(repository: GitRepository): Promise<string> {
  return runGitOrThrow(
    repository,
    ["log", "-1", "--pretty=format:%h %s"],
    "Reading created commit",
  );
}
