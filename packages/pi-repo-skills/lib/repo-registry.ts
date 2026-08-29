// Shared helpers for per-repository pi extensions.
//
// Provides one place for:
//   - resolving a stable per-repo key from a working directory (git root, with
//     worktrees folded onto their main root), and
//   - reading/writing small JSON config files under ~/.pi/<name>/.
//
// Each extension keeps its own config schema; only the git resolution and the
// JSON IO plumbing are shared.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RepoMeta {
  /** Absolute main worktree root — the stable registry key across worktrees. */
  key: string;
  /** Basename of the root, for display. */
  name: string;
}

const repoMetaCache = new Map<string, RepoMeta>();

/** Git prints slash-normalized paths on Windows; canonicalize to the native
 * real path so registry keys match Node-side paths and stay stable. */
function toRepoKey(gitPath: string): string {
  try {
    return fs.realpathSync.native(gitPath);
  } catch {
    return path.normalize(gitPath);
  }
}

function execGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: path.resolve(cwd),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the per-repo key + display name for a working directory.
 *
 * Uses the main worktree root (first line of `git worktree list`) so a worktree
 * and its main repo share one preference. Falls back to the git toplevel, then
 * to the resolved cwd for non-git directories. Cached per absolute cwd.
 */
export function getRepoMeta(cwd: string): RepoMeta {
  const abs = path.resolve(cwd);
  const cached = repoMetaCache.get(abs);
  if (cached) return cached;

  const gitRoot = execGit(abs, ["rev-parse", "--show-toplevel"]);
  const worktreeList = execGit(abs, ["worktree", "list", "--porcelain"]);
  const worktreeLine = worktreeList?.split("\n").find((line) => line.startsWith("worktree "));
  const mainRoot = worktreeLine?.slice("worktree ".length);
  const root = mainRoot ?? gitRoot;
  const key = root ? toRepoKey(root) : abs;

  const meta: RepoMeta = { key, name: path.basename(key) };
  repoMetaCache.set(abs, meta);
  return meta;
}

/** Absolute path to a machine-local pi config directory: ~/.pi/<name>. */
export function piConfigDir(name: string): string {
  return path.join(os.homedir(), ".pi", name);
}

/** Read + parse a JSON file, returning `fallback` if it is missing or invalid. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/** Write a JSON file, creating parent directories. Throws on failure. */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
