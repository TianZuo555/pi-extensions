/**
 * Git workflow — typed Effect programs for pi-commit repository mutations.
 *
 * UI dialogs, loaders, and pi exec wiring stay in `index.ts`; this module owns
 * the multi-step Git transaction, verification, and error finalization flow.
 */

import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { Data, Effect } from "effect";
import type { CommitPlan } from "../lib/prompt.ts";
import {
  commitWithMessage,
  describeGitFailure,
  ensureNoUnmergedEntries,
  hasUnstagedChanges,
  openGitRepository,
  pushCurrentBranch,
  readLatestCommitSummary,
  readStagedPaths,
  readStagedSnapshot,
  resetStagedChanges,
  stageAllChanges,
  stageSelectedPaths,
  verifyStagedSnapshot,
  type ExecFunction,
  type GitRepository,
  type StagedSnapshot,
} from "../lib/git.ts";

export class GitWorkflowError extends Data.TaggedError("GitWorkflowError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type PlannedCommitResult =
  | { readonly status: "success"; readonly summaries: readonly string[] }
  | { readonly status: "error"; readonly error: GitWorkflowError; readonly summaries: readonly string[] };

type PlannedCommitErrorResult = Extract<PlannedCommitResult, { readonly status: "error" }>;

export type PlannedCommitStepResult =
  | { readonly kind: "summary"; readonly summary: string }
  | { readonly kind: "failure"; readonly result: PlannedCommitErrorResult };

function gitError(message: string, cause?: unknown): GitWorkflowError {
  return new GitWorkflowError({ message, ...(cause !== undefined ? { cause } : {}) });
}

function plannedCommitError(
  error: GitWorkflowError,
  summaries: readonly string[],
): PlannedCommitErrorResult {
  return { status: "error", error, summaries: [...summaries] };
}

function tryGit<A>(label: string, tryFn: () => Promise<A>): Effect.Effect<A, GitWorkflowError> {
  return Effect.tryPromise({
    try: tryFn,
    catch: (cause) =>
      cause instanceof GitWorkflowError
        ? cause
        : gitError(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
  });
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((filePath) => rightSet.has(filePath));
}

export function openRepositoryEffect(
  exec: ExecFunction,
  cwd: string,
): Effect.Effect<GitRepository, GitWorkflowError> {
  return tryGit("Finding Git repository", () => openGitRepository(exec, cwd));
}

export function readStagedSnapshotEffect(
  repository: GitRepository,
  maxPatchBytes: number,
): Effect.Effect<StagedSnapshot, GitWorkflowError> {
  return tryGit("Reading staged snapshot", () => readStagedSnapshot(repository, maxPatchBytes));
}

export function ensureCleanIndexEffect(repository: GitRepository): Effect.Effect<void, GitWorkflowError> {
  return tryGit("Checking merge conflicts", () => ensureNoUnmergedEntries(repository));
}

export function stageAllChangesEffect(repository: GitRepository): Effect.Effect<void, GitWorkflowError> {
  return tryGit("Staging all changes", () => stageAllChanges(repository));
}

export function verifySnapshotEffect(
  repository: GitRepository,
  snapshot: StagedSnapshot,
): Effect.Effect<void, GitWorkflowError> {
  return tryGit("Verifying staged snapshot", () => verifyStagedSnapshot(repository, snapshot));
}

export function commitWithMessageEffect(
  repository: GitRepository,
  message: string,
): Effect.Effect<ExecResult, GitWorkflowError> {
  return tryGit("Creating commit", () => commitWithMessage(repository, message));
}

export function readLatestCommitSummaryEffect(
  repository: GitRepository,
): Effect.Effect<string, GitWorkflowError> {
  return tryGit("Reading created commit", () => readLatestCommitSummary(repository));
}

export function pushCurrentBranchEffect(
  repository: GitRepository,
  signal?: AbortSignal,
): Effect.Effect<ExecResult, GitWorkflowError> {
  return tryGit("Pushing commit", () => pushCurrentBranch(repository, signal));
}

export function restageAfterPlanFailureEffect(
  repository: GitRepository,
): Effect.Effect<string | undefined, never> {
  return Effect.promise(async () => {
    try {
      await stageAllChanges(repository);
      return undefined;
    } catch (error) {
      return `Could not restore all remaining changes to the index: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
}

export function plannedCommitPreflightEffect(
  repository: GitRepository,
  snapshot: StagedSnapshot,
): Effect.Effect<PlannedCommitErrorResult | undefined, never> {
  return Effect.gen(function* () {
    yield* verifySnapshotEffect(repository, snapshot);
    const unstaged = yield* tryGit("Reading Git status", () => hasUnstagedChanges(repository));
    if (unstaged) {
      return plannedCommitError(
        gitError("The working tree changed while reviewing the commit plan. Run /commit-all again."),
        [],
      );
    }
    return undefined;
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.gen(function* () {
        const restorationError = yield* restageAfterPlanFailureEffect(repository);
        const detail =
          error instanceof GitWorkflowError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        return plannedCommitError(
          gitError(restorationError ? `${detail}\n${restorationError}` : detail),
          [],
        );
      }),
    ),
  );
}

export function commitSinglePlannedGroupEffect(
  repository: GitRepository,
  commit: CommitPlan["commits"][number],
  index: number,
  total: number,
  priorSummaries: readonly string[],
): Effect.Effect<PlannedCommitStepResult, never> {
  return Effect.gen(function* () {
    if (index > 0) {
      const unexpectedPaths = yield* tryGit("Reading staged paths", () => readStagedPaths(repository));
      if (unexpectedPaths.length > 0) {
        return {
          kind: "failure",
          result: plannedCommitError(
            gitError(
              `The index changed while creating commit ${index + 1}; staged paths: ${unexpectedPaths.join(", ")}.`,
            ),
            priorSummaries,
          ),
        } satisfies PlannedCommitStepResult;
      }
    }

    yield* tryGit("Resetting staged changes", () => resetStagedChanges(repository));
    yield* tryGit("Staging commit group", () => stageSelectedPaths(repository, commit.paths));
    const stagedPaths = yield* tryGit("Reading staged paths", () => readStagedPaths(repository));
    if (!samePathSet(stagedPaths, commit.paths)) {
      return {
        kind: "failure",
        result: plannedCommitError(
          gitError(
            `Could not stage exactly the paths for commit ${index + 1}. Expected ${commit.paths.join(", ")}; got ${stagedPaths.join(", ") || "none"}.`,
          ),
          priorSummaries,
        ),
      } satisfies PlannedCommitStepResult;
    }

    const commitResult = yield* commitWithMessageEffect(repository, commit.message);
    if (commitResult.code !== 0) {
      const restorationError = yield* restageAfterPlanFailureEffect(repository);
      const detail = describeGitFailure(`Creating commit ${index + 1}`, commitResult);
      return {
        kind: "failure",
        result: plannedCommitError(
          gitError(restorationError ? `${detail}\n${restorationError}` : detail),
          priorSummaries,
        ),
      } satisfies PlannedCommitStepResult;
    }

    const summary = yield* readLatestCommitSummaryEffect(repository).pipe(
      Effect.orElseSucceed(() => `commit ${index + 1}/${total}`),
    );
    return { kind: "summary", summary } satisfies PlannedCommitStepResult;
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.gen(function* () {
        const restorationError = yield* restageAfterPlanFailureEffect(repository);
        const detail =
          error instanceof GitWorkflowError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        return {
          kind: "failure",
          result: plannedCommitError(
            gitError(restorationError ? `${detail}\n${restorationError}` : detail),
            priorSummaries,
          ),
        } satisfies PlannedCommitStepResult;
      }),
    ),
  );
}

/** Compose the full planned-commit transaction (used by tests). */
export function commitPlannedChangesEffect(
  repository: GitRepository,
  snapshot: StagedSnapshot,
  plan: CommitPlan,
): Effect.Effect<PlannedCommitResult, never> {
  const summaries: string[] = [];

  return Effect.gen(function* () {
    const preflight = yield* plannedCommitPreflightEffect(repository, snapshot);
    if (preflight !== undefined) return preflight;

    for (const [index, commit] of plan.commits.entries()) {
      const step = yield* commitSinglePlannedGroupEffect(
        repository,
        commit,
        index,
        plan.commits.length,
        summaries,
      );
      if (step.kind === "failure") return step.result;
      summaries.push(step.summary);
    }

    return { status: "success", summaries } satisfies PlannedCommitResult;
  });
}
