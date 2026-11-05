// Session labels from the project folder, or from the worktree and its branch.
//
// Rex labels a new session with two lowercase words. The extension replaces
// that name with the folder name, so the session matches the project. A linked
// worktree adds the main repository folder and the branch, because the folder
// alone does not tell two worktrees apart: `Wrktree—<repo>—<branch>`.

import path from "node:path";

export type GitExec = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ code: number; stdout: string }>;

export interface WorktreeEntry {
  readonly path: string;
  readonly head: string;
  readonly branch?: string;
}

/** Parse `git worktree list --porcelain` into one entry per worktree. */
export function parseWorktrees(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: { path: string; head: string; branch?: string } | undefined;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), head: "" };
      entries.push(current);
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  return entries;
}

/** Session label: the folder name, or the worktree label inside a linked worktree. */
export async function sessionLabel(exec: GitExec, cwd: string, timeout: number): Promise<string> {
  const folder = path.basename(cwd) || cwd;
  let entries: WorktreeEntry[];
  try {
    const result = await exec("git", ["worktree", "list", "--porcelain"], { cwd, timeout });
    if (result.code !== 0) return folder;
    entries = parseWorktrees(result.stdout);
  } catch {
    return folder;
  }
  const main = entries[0];
  const current = entries.find((entry) => contains(entry.path, cwd));
  // A main checkout keeps the folder name. A linked worktree adds the branch.
  if (!main || !current || current === main) return folder;
  const branch = current.branch?.replace(/^refs\/heads\//, "") || current.head.slice(0, 7);
  if (!branch) return folder;
  return `Wrktree—${path.basename(main.path) || main.path}—${branch}`;
}

/** True when `cwd` is `root` or inside it. */
function contains(root: string, cwd: string): boolean {
  const relative = path.relative(root, cwd);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
