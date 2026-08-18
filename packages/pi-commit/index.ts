// pi-commit — generate reviewed Git commit messages with a dedicated model.
//
// Architecture: model resolution and LLM generation live in an Effect v4
// `CommitRuntime` service (see `src/runtime.ts`). Git mutations and pi UI
// sequencing stay in this imperative boundary.
//
// Commands:
//   /commit [guidance]      generate a message for already-staged changes
//   /commit-all [guidance]  explicitly stage every change, then plan logical commits
//
// Model configuration is read on every invocation from Pi settings:
//   { "piCommit": { "model": "provider/model", "fallbackModel": "provider/fallback", "thinkingLevel": "high" } }
// Project .pi/settings.json overrides the global setting when the project is trusted.

import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadCommitSettings,
  type CommitSettingsResolution,
} from "./lib/config.ts";
import {
  describeGitFailure,
  hasWorkingTreeChanges,
  truncateUtf8,
  type ExecFunction,
  type GitRepository,
  type StagedSnapshot,
} from "./lib/git.ts";
import { CommitPlanEditor } from "./lib/commit-plan-editor.ts";
import {
  MAX_PATCH_BYTES,
  normalizeEditedCommitMessage,
  type CommitPlan,
} from "./lib/prompt.ts";
import {
  commitSinglePlannedGroupEffect,
  commitWithMessageEffect,
  ensureCleanIndexEffect,
  GitWorkflowError,
  openRepositoryEffect,
  plannedCommitPreflightEffect,
  pushCurrentBranchEffect,
  readLatestCommitSummaryEffect,
  readStagedSnapshotEffect,
  stageAllChangesEffect,
  verifySnapshotEffect,
} from "./src/git-workflow.ts";
import {
  CommitRuntime,
  createCommitRuntime,
  runCommit,
  type CommitRuntimeInstance,
  type CommitRuntimeShape,
  type ResolvedCommitModels,
  type ResolvedModel,
} from "./src/runtime.ts";

type GenerationOutcome<T> =
  | { status: "success"; value: T }
  | { status: "cancelled" }
  | { status: "error"; error: Error };

type PlannedCommitRun =
  | { status: "success"; summaries: string[] }
  | { status: "error"; error: Error; summaries: string[] };

type OperationOutcome<T> =
  | { status: "success"; value: T }
  | { status: "cancelled" }
  | { status: "error"; error: Error };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function compactError(error: unknown): string {
  const text = asError(error).message;
  const truncated = truncateUtf8(text, 8 * 1024);
  return truncated.omittedBytes > 0
    ? `${truncated.text}\n… ${truncated.omittedBytes} bytes omitted`
    : truncated.text;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function runLoaderOperation<T>(
  ctx: ExtensionCommandContext,
  message: string,
  operation: (signal?: AbortSignal) => Promise<T>,
  options: { cancellable?: boolean } = { cancellable: false },
): Promise<OperationOutcome<T>> {
  const run = async (signal?: AbortSignal): Promise<OperationOutcome<T>> => {
    try {
      const value = await operation(signal);
      return signal?.aborted ? { status: "cancelled" } : { status: "success", value };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return { status: "cancelled" };
      return { status: "error", error: asError(error) };
    }
  };

  if (ctx.mode !== "tui") {
    ctx.ui.setStatus("pi-commit", message);
    try {
      return await run();
    } finally {
      ctx.ui.setStatus("pi-commit", undefined);
    }
  }

  return ctx.ui.custom<OperationOutcome<T>>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, message, options);
    void run(loader.signal).then(done);
    return loader;
  });
}

async function runWithLoader<T>(
  ctx: ExtensionCommandContext,
  message: string,
  operation: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const outcome = await runLoaderOperation(ctx, message, operation);
  if (outcome.status === "success") return outcome.value;
  if (outcome.status === "cancelled") throw operationAbortError();
  throw outcome.error;
}

async function runCancellableWithLoader<T>(
  ctx: ExtensionCommandContext,
  message: string,
  operation: (signal?: AbortSignal) => Promise<T>,
): Promise<OperationOutcome<T>> {
  return runLoaderOperation(ctx, message, operation, { cancellable: true });
}

function operationAbortError(): Error {
  const error = new Error("Commit operation was aborted");
  error.name = "AbortError";
  return error;
}

async function generateWithLoader<T>(
  ctx: ExtensionCommandContext,
  resolved: ResolvedModel,
  loaderMessage: string,
  operation: (signal?: AbortSignal) => Promise<T | undefined | void>,
): Promise<GenerationOutcome<T>> {
  const run = async (signal?: AbortSignal): Promise<GenerationOutcome<T>> => {
    try {
      const value = await operation(signal);
      return value === undefined ? { status: "cancelled" } : { status: "success", value };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return { status: "cancelled" };
      return { status: "error", error: asError(error) };
    }
  };

  if (ctx.mode !== "tui") {
    ctx.ui.notify(loaderMessage, "info");
    return run();
  }

  return ctx.ui.custom<GenerationOutcome<T>>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, loaderMessage);
    let settled = false;
    const finish = (outcome: GenerationOutcome<T>) => {
      if (settled) return;
      settled = true;
      done(outcome);
    };

    loader.onAbort = () => finish({ status: "cancelled" });
    void run(loader.signal).then(finish);
    return loader;
  });
}

async function generateCommitMessage(
  ctx: ExtensionCommandContext,
  commit: CommitRuntimeShape,
  runtime: CommitRuntimeInstance,
  models: ResolvedCommitModels,
  settings: CommitSettingsResolution,
  snapshot: StagedSnapshot,
  guidance: string,
): Promise<GenerationOutcome<string>> {
  return generateWithModelFallback(
    ctx,
    models,
    settings,
    (resolved) =>
      generateWithLoader(
        ctx,
        resolved,
        `Generating commit message with ${resolved.reference.value}…`,
        (signal) =>
          runCommit(
            runtime,
            commit.requestCommitMessage(resolved, snapshot, guidance, signal),
            { signal },
          ),
      ),
  );
}

async function generateCommitPlan(
  ctx: ExtensionCommandContext,
  commit: CommitRuntimeShape,
  runtime: CommitRuntimeInstance,
  models: ResolvedCommitModels,
  settings: CommitSettingsResolution,
  snapshot: StagedSnapshot,
  guidance: string,
): Promise<GenerationOutcome<CommitPlan>> {
  return generateWithModelFallback(
    ctx,
    models,
    settings,
    (resolved) =>
      generateWithLoader(
        ctx,
        resolved,
        `Generating logical commit plan with ${resolved.reference.value}…`,
        (signal) =>
          runCommit(
            runtime,
            commit.requestCommitPlan(resolved, snapshot, guidance, signal),
            { signal },
          ),
      ),
  );
}

async function generateWithModelFallback<T>(
  ctx: ExtensionCommandContext,
  models: ResolvedCommitModels,
  settings: CommitSettingsResolution,
  generate: (resolved: ResolvedModel) => Promise<GenerationOutcome<T>>,
): Promise<GenerationOutcome<T>> {
  const first = await generate(models.active);
  if (
    first.status !== "error" ||
    !models.fallback ||
    models.active.reference.value === models.fallback.reference.value
  ) {
    return first;
  }

  ctx.ui.notify(
    `Generating with ${models.active.reference.value} failed; retrying with ${models.fallback.reference.value}.`,
    "warning",
  );
  return generate(models.fallback);
}

function resolutionFallbackNotice(
  models: ResolvedCommitModels,
  settings: CommitSettingsResolution,
): string | undefined {
  if (models.primary || !models.fallback || !settings.fallbackModel) return undefined;
  return `Commit model ${settings.model.value} is unavailable; using fallback ${models.fallback.reference.value}.`;
}

function cancellationNotice(stageAllWasRun: boolean): string {
  return stageAllWasRun
    ? "Commit cancelled. Changes staged by /commit-all remain staged."
    : "Commit cancelled.";
}

function failureSuffix(stageAllWasRun: boolean): string {
  return stageAllWasRun ? "\nChanges staged by /commit-all remain staged." : "";
}

async function editCommitPlan(
  ctx: ExtensionCommandContext,
  plan: CommitPlan,
): Promise<CommitPlan | undefined> {
  if (ctx.mode === "tui" && plan.commits.length > 1) {
    const edited = await ctx.ui.custom<CommitPlan | undefined>((tui, theme, keybindings, done) =>
      new CommitPlanEditor(tui, theme, keybindings, plan.commits, (result) =>
        done(result ?? undefined),
      ),
    );
    return edited;
  }

  const commits: CommitPlan["commits"] = [];
  for (const [index, commit] of plan.commits.entries()) {
    const label = commit.paths.length === 1
      ? commit.paths[0]
      : `${commit.paths.length} files`;
    const edited = await ctx.ui.editor(
      `Edit commit message ${index + 1}/${plan.commits.length} (${label})`,
      commit.message,
    );
    if (edited === undefined) return undefined;
    commits.push({ paths: commit.paths, message: normalizeEditedCommitMessage(edited) });
  }
  return { commits };
}

async function commitPlannedChanges(
  ctx: ExtensionCommandContext,
  runtime: CommitRuntimeInstance,
  repository: GitRepository,
  snapshot: StagedSnapshot,
  plan: CommitPlan,
): Promise<PlannedCommitRun> {
  const preflight = await runCommit(runtime, plannedCommitPreflightEffect(repository, snapshot));
  if (preflight !== undefined) {
    return {
      status: "error",
      error: new Error(preflight.error.message),
      summaries: [...preflight.summaries],
    };
  }

  const summaries: string[] = [];
  for (const [index, commit] of plan.commits.entries()) {
    const step = await runWithLoader(
      ctx,
      `Creating commit ${index + 1}/${plan.commits.length}…`,
      () =>
        runCommit(
          runtime,
          commitSinglePlannedGroupEffect(
            repository,
            commit,
            index,
            plan.commits.length,
            summaries,
          ),
        ),
    );
    if (step.kind === "failure") {
      return {
        status: "error",
        error: new Error(step.result.error.message),
        summaries: [...step.result.summaries],
      };
    }
    summaries.push(step.summary);
  }

  return { status: "success", summaries };
}

async function runCommitWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  commit: CommitRuntimeShape,
  runtime: CommitRuntimeInstance,
  guidance: string,
  stageAll: boolean,
): Promise<void> {
  let stageAllWasRun = false;

  try {
    const settings = await loadCommitSettings(ctx.cwd, ctx.isProjectTrusted());
    if (settings.warnings.length > 0) {
      throw new Error(`pi-commit settings:\n${settings.warnings.join("\n")}`);
    }
    const models = await runCommit(runtime, commit.resolveCommitModels(ctx, settings));
    const resolutionNotice = resolutionFallbackNotice(models, settings);
    if (resolutionNotice) {
      ctx.ui.notify(resolutionNotice, "warning");
    }

    const exec: ExecFunction = (command, args, options) => pi.exec(command, args, options);
    const repository = await runCommit(runtime, openRepositoryEffect(exec, ctx.cwd));
    await runCommit(runtime, ensureCleanIndexEffect(repository));

    if (stageAll) {
      if (!(await hasWorkingTreeChanges(repository))) {
        ctx.ui.notify("Nothing to commit.", "info");
        return;
      }

      const approved = await ctx.ui.confirm(
        "Stage all changes?",
        `Repository: ${repository.root}\n\nThis stages tracked, deleted, and untracked files (ignored files stay ignored). If you cancel later, the staged changes remain staged.`,
      );
      if (!approved) {
        ctx.ui.notify("Commit cancelled before staging.", "info");
        return;
      }

      stageAllWasRun = true;
      await runCommit(runtime, stageAllChangesEffect(repository));
      await runCommit(runtime, ensureCleanIndexEffect(repository));
    }

    const snapshot = await runCommit(runtime, readStagedSnapshotEffect(repository, MAX_PATCH_BYTES));
    if (snapshot.omittedPatchBytes > 0) {
      ctx.ui.notify(
        `The staged patch is large; ${snapshot.omittedPatchBytes} bytes were omitted from model context. The complete file list and stat are still included.`,
        "warning",
      );
    }

    const CHOICE_PUSH = "Commit and push";
    const CHOICE_COMMIT = "Commit only";
    const CHOICE_CANCEL = "Cancel";

    if (!stageAll) {
      const generation = await generateCommitMessage(ctx, commit, runtime, models, settings, snapshot, guidance);
      if (generation.status === "cancelled") {
        ctx.ui.notify(cancellationNotice(stageAllWasRun), "info");
        return;
      }
      if (generation.status === "error") {
        throw new Error(
          `Generating a commit message with ${models.active.reference.value} failed: ${generation.error.message}`,
        );
      }

      const edited = await ctx.ui.editor("Edit commit message", generation.value);
      if (edited === undefined) {
        ctx.ui.notify(cancellationNotice(stageAllWasRun), "info");
        return;
      }
      const message = normalizeEditedCommitMessage(edited);
      const choice = await ctx.ui.select(`Commit ${snapshot.branch}?`, [
        CHOICE_PUSH,
        CHOICE_COMMIT,
        CHOICE_CANCEL,
      ]);
      if (choice === undefined || choice === CHOICE_CANCEL) {
        ctx.ui.notify(cancellationNotice(stageAllWasRun), "info");
        return;
      }

      await runCommit(runtime, verifySnapshotEffect(repository, snapshot));
      const commitResult = await runWithLoader(ctx, "Creating commit…", () =>
        runCommit(runtime, commitWithMessageEffect(repository, message)),
      );
      if (commitResult.code !== 0) {
        ctx.ui.notify(
          `${describeGitFailure("Creating commit", commitResult)}\nStaged changes were kept.`,
          "error",
        );
        return;
      }

      let summary: string;
      try {
        summary = await runCommit(runtime, readLatestCommitSummaryEffect(repository));
      } catch {
        ctx.ui.notify("Commit created successfully.", "info");
        return;
      }

      if (choice === CHOICE_PUSH) {
        const pushOutcome = await runCancellableWithLoader(
          ctx,
          `Pushing ${snapshot.branch}…`,
          (signal) =>
            runCommit(
              runtime,
              pushCurrentBranchEffect(repository, signal),
              { signal },
            ),
        );
        if (pushOutcome.status === "cancelled") {
          ctx.ui.notify(`Push cancelled. Commit ${summary} was created locally.`, "info");
          return;
        }
        if (pushOutcome.status === "error") throw pushOutcome.error;
        if (pushOutcome.value.code !== 0) {
          ctx.ui.notify(
            `${describeGitFailure("Pushing commit", pushOutcome.value)}\nCommit ${summary} was created locally.`,
            "error",
          );
          return;
        }
        ctx.ui.notify(`Committed and pushed ${summary}`, "info");
        return;
      }

      ctx.ui.notify(`Committed ${summary}`, "info");
      return;
    }

    const generation = await generateCommitPlan(ctx, commit, runtime, models, settings, snapshot, guidance);
    if (generation.status === "cancelled") {
      ctx.ui.notify(cancellationNotice(stageAllWasRun), "info");
      return;
    }
    if (generation.status === "error") {
      throw new Error(
        `Generating a logical commit plan with ${models.active.reference.value} failed: ${generation.error.message}`,
      );
    }

    const editedPlan = await editCommitPlan(ctx, generation.value);
    if (editedPlan === undefined) {
      ctx.ui.notify(cancellationNotice(stageAllWasRun), "info");
      return;
    }

    const choice = await ctx.ui.select(`Commit ${snapshot.branch} as ${editedPlan.commits.length} commit(s)?`, [
      CHOICE_PUSH,
      CHOICE_COMMIT,
      CHOICE_CANCEL,
    ]);
    if (choice === undefined || choice === CHOICE_CANCEL) {
      ctx.ui.notify(cancellationNotice(stageAllWasRun), "info");
      return;
    }

    const plannedRun = await commitPlannedChanges(ctx, runtime, repository, snapshot, editedPlan);
    if (plannedRun.status === "error") {
      const completed = plannedRun.summaries.length > 0
        ? `\nPreviously created commits: ${plannedRun.summaries.join("; ")}`
        : "";
      ctx.ui.notify(
        `${compactError(plannedRun.error)}${completed}\nChanges staged by /commit-all remain staged.`,
        "error",
      );
      return;
    }

    const summaries = plannedRun.summaries.join("; ");
    if (choice === CHOICE_PUSH) {
      const pushOutcome = await runCancellableWithLoader(
        ctx,
        `Pushing ${snapshot.branch}…`,
        (signal) =>
          runCommit(
            runtime,
            pushCurrentBranchEffect(repository, signal),
            { signal },
          ),
      );
      if (pushOutcome.status === "cancelled") {
        ctx.ui.notify(`Push cancelled. Commits ${summaries} were created locally.`, "info");
        return;
      }
      if (pushOutcome.status === "error") throw pushOutcome.error;
      if (pushOutcome.value.code !== 0) {
        ctx.ui.notify(
          `${describeGitFailure("Pushing commits", pushOutcome.value)}\nCommits ${summaries} were created locally.`,
          "error",
        );
        return;
      }
      ctx.ui.notify(`Committed and pushed ${summaries}`, "info");
      return;
    }

    ctx.ui.notify(`Committed ${summaries}`, "info");
  } catch (error) {
    const message =
      error instanceof GitWorkflowError
        ? error.message
        : compactError(error);
    ctx.ui.notify(`${message}${failureSuffix(stageAllWasRun)}`, "error");
  }
}

export default function commitExtension(pi: ExtensionAPI): void {
  let commandRunning = false;
  let commitRuntime: CommitRuntimeInstance | undefined;
  let commitService: CommitRuntimeShape | undefined;

  pi.on("session_start", () => {
    commitRuntime = createCommitRuntime();
    commitService = commitRuntime.runSync(CommitRuntime);
  });

  pi.on("session_shutdown", async () => {
    if (commitRuntime) {
      await commitRuntime.dispose();
      commitRuntime = undefined;
      commitService = undefined;
    }
  });

  const register = (name: "commit" | "commit-all", stageAll: boolean, description: string) => {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        if (!ctx.hasUI) {
          ctx.ui.notify(`/${name} requires interactive or RPC UI confirmation.`, "error");
          return;
        }
        if (commandRunning) {
          ctx.ui.notify("Another commit command is already running.", "warning");
          return;
        }

        if (!commitRuntime || !commitService) {
          ctx.ui.notify("Commit runtime is not initialized.", "error");
          return;
        }

        commandRunning = true;
        try {
          await ctx.waitForIdle();
          await runCommitWorkflow(pi, ctx, commitService, commitRuntime, args.trim(), stageAll);
        } finally {
          commandRunning = false;
        }
      },
    });
  };

  register("commit", false, "Generate and review a commit for staged changes; optional arguments guide the message");
  register("commit-all", true, "Stage all changes, then plan and review logical commits; optional arguments guide the messages");
}
