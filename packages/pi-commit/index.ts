// pi-commit — generate reviewed Git commit messages with a dedicated model.
//
// Commands:
//   /commit [guidance]      generate a message for already-staged changes
//   /commit-all [guidance]  explicitly stage every change, then plan logical commits
//
// Model configuration is read on every invocation from Pi settings:
//   { "piCommit": { "model": "provider/model", "thinkingLevel": "high" } }
// Project .pi/settings.json overrides the global setting when the project is trusted.

import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadCommitSettings,
  type CommitThinkingLevel,
  type ModelReference,
} from "./lib/config.ts";
import {
  commitWithMessage,
  describeGitFailure,
  ensureNoUnmergedEntries,
  hasUnstagedChanges,
  hasWorkingTreeChanges,
  openGitRepository,
  pushCurrentBranch,
  readLatestCommitSummary,
  readStagedPaths,
  readStagedSnapshot,
  resetStagedChanges,
  stageAllChanges,
  stageSelectedPaths,
  truncateUtf8,
  verifyStagedSnapshot,
  type ExecFunction,
  type GitRepository,
  type StagedSnapshot,
} from "./lib/git.ts";
import {
  buildCommitAllPrompt,
  buildCommitPrompt,
  COMMIT_ALL_SYSTEM_PROMPT,
  COMMIT_SYSTEM_PROMPT,
  MAX_PATCH_BYTES,
  normalizeEditedCommitMessage,
  normalizeGeneratedCommitMessage,
  normalizeGeneratedCommitPlan,
  type CommitPlan,
} from "./lib/prompt.ts";

interface ResolvedAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface ProviderInvoker {
  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): { result(): Promise<AssistantMessage> };
}

interface ProviderRegistry {
  getProvider?: (provider: string) => ProviderInvoker | undefined;
}

interface ResolvedModel {
  model: Model<Api>;
  reference: ModelReference;
  thinkingLevel?: CommitThinkingLevel;
  auth: ResolvedAuth;
  providerInvoker?: ProviderInvoker;
}

type GenerationOutcome<T> =
  | { status: "success"; value: T }
  | { status: "cancelled" }
  | { status: "error"; error: Error };

type PlannedCommitRun =
  | { status: "success"; summaries: string[] }
  | { status: "error"; error: Error; summaries: string[] };

type OperationOutcome<T> =
  | { status: "success"; value: T }
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

function getProviderInvoker(
  registry: ExtensionCommandContext["modelRegistry"],
  provider: string,
): ProviderInvoker | undefined {
  const registryWithProvider = registry as ProviderRegistry;
  return registryWithProvider.getProvider?.(provider);
}

async function resolveConfiguredModel(
  ctx: ExtensionCommandContext,
  reference: ModelReference,
  thinkingLevel?: CommitThinkingLevel,
): Promise<ResolvedModel> {
  const model = ctx.modelRegistry.find(reference.provider, reference.id);
  if (!model) {
    throw new Error(
      `Commit model ${reference.value} was not found. Check piCommit.model in settings.json or configure the model in models.json.`,
    );
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(`Commit model ${reference.value} is unavailable: ${auth.error}`);
  }

  return {
    model,
    reference,
    thinkingLevel,
    auth,
    // Newer Pi runtimes expose the native provider on the registry. Using it
    // keeps provider-specific request handling inside Pi's SDK.
    providerInvoker: getProviderInvoker(ctx.modelRegistry, reference.provider),
  };
}

async function requestModelText(
  resolved: ResolvedModel,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const context: Context = {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userPrompt }],
        timestamp: Date.now(),
      },
    ],
  };
  const options: SimpleStreamOptions = {
    apiKey: resolved.auth.apiKey,
    headers: resolved.auth.headers,
    env: resolved.auth.env,
    signal,
    cacheRetention: "none",
    maxTokens,
    reasoning: resolved.thinkingLevel === "off" ? undefined : resolved.thinkingLevel,
    timeoutMs: 120_000,
    maxRetries: 0,
    maxRetryDelayMs: 60_000,
    sessionId: randomUUID(),
  };
  const response = resolved.providerInvoker
    ? await resolved.providerInvoker.streamSimple(resolved.model, context, options).result()
    : await completeSimple(resolved.model, context, options);

  if (response.stopReason === "aborted") return undefined;
  if (response.stopReason !== "stop") {
    throw new Error(
      response.errorMessage
        ? `${response.stopReason}: ${response.errorMessage}`
        : `model stopped with ${response.stopReason}`,
    );
  }

  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function requestCommitMessage(
  resolved: ResolvedModel,
  snapshot: StagedSnapshot,
  guidance: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const text = await requestModelText(
    resolved,
    COMMIT_SYSTEM_PROMPT,
    buildCommitPrompt(snapshot, guidance),
    2048,
    signal,
  );
  return text === undefined ? undefined : normalizeGeneratedCommitMessage(text);
}

async function requestCommitPlan(
  resolved: ResolvedModel,
  snapshot: StagedSnapshot,
  guidance: string,
  signal?: AbortSignal,
): Promise<CommitPlan | undefined> {
  const text = await requestModelText(
    resolved,
    COMMIT_ALL_SYSTEM_PROMPT,
    buildCommitAllPrompt(snapshot, guidance),
    8192,
    signal,
  );
  return text === undefined ? undefined : normalizeGeneratedCommitPlan(text, snapshot.paths);
}

async function runWithLoader<T>(
  ctx: ExtensionCommandContext,
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (ctx.mode !== "tui") {
    ctx.ui.setStatus("pi-commit", message);
    try {
      return await operation();
    } finally {
      ctx.ui.setStatus("pi-commit", undefined);
    }
  }

  const outcome = await ctx.ui.custom<OperationOutcome<T>>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, message, { cancellable: false });
    void operation().then(
      (value) => done({ status: "success", value }),
      (error) => done({ status: "error", error: asError(error) }),
    );
    return loader;
  });

  if (outcome.status === "error") throw outcome.error;
  return outcome.value;
}

async function generateWithLoader<T>(
  ctx: ExtensionCommandContext,
  resolved: ResolvedModel,
  loaderMessage: string,
  operation: (signal?: AbortSignal) => Promise<T | undefined>,
): Promise<GenerationOutcome<T>> {
  const run = async (signal?: AbortSignal): Promise<GenerationOutcome<T>> => {
    try {
      const value = await operation(signal);
      return value === undefined ? { status: "cancelled" } : { status: "success", value };
    } catch (error) {
      if (signal?.aborted) return { status: "cancelled" };
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
  resolved: ResolvedModel,
  snapshot: StagedSnapshot,
  guidance: string,
): Promise<GenerationOutcome<string>> {
  return generateWithLoader(
    ctx,
    resolved,
    `Generating commit message with ${resolved.reference.value}…`,
    (signal) => requestCommitMessage(resolved, snapshot, guidance, signal),
  );
}

async function generateCommitPlan(
  ctx: ExtensionCommandContext,
  resolved: ResolvedModel,
  snapshot: StagedSnapshot,
  guidance: string,
): Promise<GenerationOutcome<CommitPlan>> {
  return generateWithLoader(
    ctx,
    resolved,
    `Generating logical commit plan with ${resolved.reference.value}…`,
    (signal) => requestCommitPlan(resolved, snapshot, guidance, signal),
  );
}

function cancellationNotice(stageAllWasRun: boolean): string {
  return stageAllWasRun
    ? "Commit cancelled. Changes staged by /commit-all remain staged."
    : "Commit cancelled.";
}

function failureSuffix(stageAllWasRun: boolean): string {
  return stageAllWasRun ? "\nChanges staged by /commit-all remain staged." : "";
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((filePath) => rightSet.has(filePath));
}

async function editCommitPlan(
  ctx: ExtensionCommandContext,
  plan: CommitPlan,
): Promise<CommitPlan | undefined> {
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

async function restageAfterPlanFailure(
  repository: GitRepository,
): Promise<string | undefined> {
  try {
    await stageAllChanges(repository);
    return undefined;
  } catch (error) {
    return `Could not restore all remaining changes to the index: ${asError(error).message}`;
  }
}

async function commitPlannedChanges(
  ctx: ExtensionCommandContext,
  repository: GitRepository,
  snapshot: StagedSnapshot,
  plan: CommitPlan,
): Promise<PlannedCommitRun> {
  const summaries: string[] = [];

  try {
    await verifyStagedSnapshot(repository, snapshot);
    if (await hasUnstagedChanges(repository)) {
      throw new Error("The working tree changed while reviewing the commit plan. Run /commit-all again.");
    }

    for (const [index, commit] of plan.commits.entries()) {
      if (index > 0) {
        const unexpectedPaths = await readStagedPaths(repository);
        if (unexpectedPaths.length > 0) {
          throw new Error(
            `The index changed while creating commit ${index + 1}; staged paths: ${unexpectedPaths.join(", ")}.`,
          );
        }
      }

      await resetStagedChanges(repository);
      await stageSelectedPaths(repository, commit.paths);
      const stagedPaths = await readStagedPaths(repository);
      if (!samePathSet(stagedPaths, commit.paths)) {
        throw new Error(
          `Could not stage exactly the paths for commit ${index + 1}. Expected ${commit.paths.join(", ")}; got ${stagedPaths.join(", ") || "none"}.`,
        );
      }

      const commitResult = await runWithLoader(ctx, `Creating commit ${index + 1}/${plan.commits.length}…`, () =>
        commitWithMessage(repository, commit.message),
      );
      if (commitResult.code !== 0) {
        const restorationError = await restageAfterPlanFailure(repository);
        const detail = describeGitFailure(`Creating commit ${index + 1}`, commitResult);
        return {
          status: "error",
          error: new Error(restorationError ? `${detail}\n${restorationError}` : detail),
          summaries,
        };
      }

      try {
        summaries.push(await readLatestCommitSummary(repository));
      } catch {
        summaries.push(`commit ${index + 1}/${plan.commits.length}`);
      }
    }
  } catch (error) {
    const restorationError = await restageAfterPlanFailure(repository);
    const detail = asError(error).message;
    return {
      status: "error",
      error: new Error(restorationError ? `${detail}\n${restorationError}` : detail),
      summaries,
    };
  }

  return { status: "success", summaries };
}

async function runCommitWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  guidance: string,
  stageAll: boolean,
): Promise<void> {
  let stageAllWasRun = false;

  try {
    const settings = await loadCommitSettings(ctx.cwd, ctx.isProjectTrusted());
    if (settings.warnings.length > 0) {
      throw new Error(`pi-commit settings:\n${settings.warnings.join("\n")}`);
    }
    const resolvedModel = await resolveConfiguredModel(
      ctx,
      settings.model,
      settings.thinkingLevel,
    );

    const exec: ExecFunction = (command, args, options) => pi.exec(command, args, options);
    const repository = await openGitRepository(exec, ctx.cwd);
    await ensureNoUnmergedEntries(repository);

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
      await stageAllChanges(repository);
      await ensureNoUnmergedEntries(repository);
    }

    const snapshot = await readStagedSnapshot(repository, MAX_PATCH_BYTES);
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
      const generation = await generateCommitMessage(ctx, resolvedModel, snapshot, guidance);
      if (generation.status === "cancelled") {
        ctx.ui.notify(cancellationNotice(stageAllWasRun), "info");
        return;
      }
      if (generation.status === "error") {
        throw new Error(
          `Generating a commit message with ${resolvedModel.reference.value} failed: ${generation.error.message}`,
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

      await verifyStagedSnapshot(repository, snapshot);
      const commitResult = await runWithLoader(ctx, "Creating commit…", () =>
        commitWithMessage(repository, message),
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
        summary = await readLatestCommitSummary(repository);
      } catch {
        ctx.ui.notify("Commit created successfully.", "info");
        return;
      }

      if (choice === CHOICE_PUSH) {
        const pushResult = await runWithLoader(ctx, `Pushing ${snapshot.branch}…`, () =>
          pushCurrentBranch(repository),
        );
        if (pushResult.code !== 0) {
          ctx.ui.notify(
            `${describeGitFailure("Pushing commit", pushResult)}\nCommit ${summary} was created locally.`,
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

    const generation = await generateCommitPlan(ctx, resolvedModel, snapshot, guidance);
    if (generation.status === "cancelled") {
      ctx.ui.notify(cancellationNotice(stageAllWasRun), "info");
      return;
    }
    if (generation.status === "error") {
      throw new Error(
        `Generating a logical commit plan with ${resolvedModel.reference.value} failed: ${generation.error.message}`,
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

    const plannedRun = await commitPlannedChanges(ctx, repository, snapshot, editedPlan);
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
      const pushResult = await runWithLoader(ctx, `Pushing ${snapshot.branch}…`, () =>
        pushCurrentBranch(repository),
      );
      if (pushResult.code !== 0) {
        ctx.ui.notify(
          `${describeGitFailure("Pushing commits", pushResult)}\nCommits ${summaries} were created locally.`,
          "error",
        );
        return;
      }
      ctx.ui.notify(`Committed and pushed ${summaries}`, "info");
      return;
    }

    ctx.ui.notify(`Committed ${summaries}`, "info");
  } catch (error) {
    ctx.ui.notify(`${compactError(error)}${failureSuffix(stageAllWasRun)}`, "error");
  }
}

export default function commitExtension(pi: ExtensionAPI): void {
  let commandRunning = false;

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

        commandRunning = true;
        try {
          await ctx.waitForIdle();
          await runCommitWorkflow(pi, ctx, args.trim(), stageAll);
        } finally {
          commandRunning = false;
        }
      },
    });
  };

  register("commit", false, "Generate and review a commit for staged changes; optional arguments guide the message");
  register("commit-all", true, "Stage all changes, then plan and review logical commits; optional arguments guide the messages");
}
