/**
 * Strip git-repo-redirecting environment variables from this test process.
 *
 * git exports GIT_DIR (and friends) to hook subprocesses, and lefthook's
 * pre-push hook passes that environment through to `pnpm test`. Left in
 * place, every git invocation — including ones spawned inside lib code such
 * as createWorktree — ignores its cwd and operates on the repository being
 * pushed instead of these fixtures. Call this once at module top, before any
 * fixture is created. Each test file runs as its own process under
 * `node --test`, so the mutation is file-scoped.
 */

const REDIRECTING_GIT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
] as const;

export function hermeticGitProcessEnv(): void {
  for (const key of REDIRECTING_GIT_ENV_KEYS) delete process.env[key];
}
