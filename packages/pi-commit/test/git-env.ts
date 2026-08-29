/**
 * Environment for git subprocesses spawned by tests.
 *
 * git exports GIT_DIR (and friends) to hook subprocesses, and lefthook's
 * pre-push hook passes that environment through to `pnpm test`. With GIT_DIR
 * set, every git invocation ignores its cwd and operates on the repository
 * being pushed instead — a pre-push test run once committed its fixtures onto
 * the real branch, renamed it, and contaminated the shared repo config. Strip
 * the redirecting variables so git resolves the repository from the working
 * directory again.
 */

const REDIRECTING_GIT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
] as const;

export function hermeticGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of REDIRECTING_GIT_ENV_KEYS) delete env[key];
  return env;
}
