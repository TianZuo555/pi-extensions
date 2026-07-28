// pi-commit — generate reviewed Git commit messages with a dedicated model.
//
// Commands:
//   /commit [guidance]      generate a message for already-staged changes
//   /commit-all [guidance]  explicitly stage every change, then generate a message
//
// Model configuration is read on every invocation from Pi settings:
//   { "piCommit": { "model": "deepseek/deepseek-v4-flash" } }
// Project .pi/settings.json overrides the global setting when the project is trusted.

import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { loadCommitSettings, type ModelReference } from "./lib/config.ts";
import {
  commitWithMessage,
  describeGitFailure,
  ensureNoUnmergedEntries,
  hasWorkingTreeChanges,
  openGitRepository,
  pushCurrentBranch,
  readLatestCommitSummary,
  readStagedSnapshot,
  stageAllChanges,
  truncateUtf8,
  verifyStagedSnapshot,
  type ExecFunction,
  type StagedSnapshot,
} from "./lib/git.ts";
import {
  buildCommitPrompt,
  COMMIT_SYSTEM_PROMPT,
  MAX_PATCH_BYTES,
  normalizeEditedCommitMessage,
  normalizeGeneratedCommitMessage,
} from "./lib/prompt.ts";

interface ResolvedAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface ResolvedModel {
  model: Model<Api>;
  reference: ModelReference;
  auth: ResolvedAuth;
}

type GenerationOutcome =
  | { status: "success"; message: string }
  | { status: "cancelled" }
  | { status: "error"; error: Error };

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

async function resolveConfiguredModel(
  ctx: ExtensionCommandContext,
  reference: ModelReference,
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

  return { model, reference, auth };
}

async function requestCommitMessage(
  resolved: ResolvedModel,
  snapshot: StagedSnapshot,
  guidance: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const response = await complete(
    resolved.model,
    {
      systemPrompt: COMMIT_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildCommitPrompt(snapshot, guidance) }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: resolved.auth.apiKey,
      headers: resolved.auth.headers,
      env: resolved.auth.env,
      signal,
      cacheRetention: "none",
      maxTokens: 2048,
      temperature: 0.1,
      timeoutMs: 120_000,
      maxRetries: 0,
      maxRetryDelayMs: 60_000,
      sessionId: randomUUID(),
    },
  );

  if (response.stopReason === "aborted") return undefined;
  if (response.stopReason !== "stop") {
    throw new Error(
      response.errorMessage
        ? `${response.stopReason}: ${response.errorMessage}`
        : `model stopped with ${response.stopReason}`,
    );
  }

  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return normalizeGeneratedCommitMessage(text);
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

async function generateCommitMessage(
  ctx: ExtensionCommandContext,
  resolved: ResolvedModel,
  snapshot: StagedSnapshot,
  guidance: string,
): Promise<GenerationOutcome> {
  const operation = async (signal?: AbortSignal): Promise<GenerationOutcome> => {
    try {
      const message = await requestCommitMessage(resolved, snapshot, guidance, signal);
      return message === undefined ? { status: "cancelled" } : { status: "success", message };
    } catch (error) {
      if (signal?.aborted) return { status: "cancelled" };
      return { status: "error", error: asError(error) };
    }
  };

  if (ctx.mode !== "tui") {
    ctx.ui.notify(`Generating commit message with ${resolved.reference.value}…`, "info");
    return operation();
  }

  return ctx.ui.custom<GenerationOutcome>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(
      tui,
      theme,
      `Generating commit message with ${resolved.reference.value}…`,
    );
    let settled = false;
    const finish = (outcome: GenerationOutcome) => {
      if (settled) return;
      settled = true;
      done(outcome);
    };

    loader.onAbort = () => finish({ status: "cancelled" });
    void operation(loader.signal).then(finish);
    return loader;
  });
}

function cancellationNotice(stageAllWasRun: boolean): string {
  return stageAllWasRun
    ? "Commit cancelled. Changes staged by /commit-all remain staged."
    : "Commit cancelled.";
}

function failureSuffix(stageAllWasRun: boolean): string {
  return stageAllWasRun ? "\nChanges staged by /commit-all remain staged." : "";
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
    const resolvedModel = await resolveConfiguredModel(ctx, settings.model);

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

    const edited = await ctx.ui.editor("Edit commit message", generation.message);
    if (edited === undefined) {
      ctx.ui.notify(cancellationNotice(stageAllWasRun), "info");
      return;
    }
    const message = normalizeEditedCommitMessage(edited);

    const CHOICE_PUSH = "Commit and push";
    const CHOICE_COMMIT = "Commit only";
    const CHOICE_CANCEL = "Cancel";
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
  register("commit-all", true, "Stage all changes, then generate and review a commit; optional arguments guide the message");
}
