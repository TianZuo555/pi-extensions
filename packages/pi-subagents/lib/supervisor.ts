import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  emptyUsage,
  MAX_CONCURRENT_RUNS,
  MAX_SESSION_RUNS,
  REPORT_MAX_BYTES,
  SESSION_COST_WARN_RATIO,
  SESSION_SOFT_COST_USD,
  truncateUtf8,
  type RunMode,
  type RunTerminalStatus,
  type SubagentRunResult,
} from "./domain.ts";
import { buildTaskPrompt } from "./prompt.ts";
import type { ProfileDefinition } from "./domain.ts";
import {
  ProfileCatalog,
  resolveProfileModelArg,
} from "./profile-catalog.ts";
import { createDetachedChildTracker, type DetachedChildTracker } from "./process-tracker.ts";
import { applyVerifiedPatch } from "./patch-apply.ts";
import { createDeferredResultDelivery } from "./result-delivery.ts";
import { runRpcChild, type RpcChildRunInput } from "./rpc-child.ts";
import { RunStore } from "./run-store.ts";
import {
  createWorktree,
  finalizeWorktree,
  getDefaultArtifactRoot,
  pruneStalePatchArtifacts,
  pruneStaleWorktrees,
  type PatchApplyStatus,
  type WorktreeDelivery,
  type WorktreeInfo,
} from "./worktree.ts";
import { ensureProjectProfileAllowed } from "./trust.ts";

export interface SupervisorRunInput {
  profile: string;
  task: string;
  context?: string;
  cwd: string;
  parentModel: Model<any> | undefined;
  mode?: RunMode;
  timeoutMs?: number;
  signal?: AbortSignal;
  onActivity?: (activity: string) => void;
  spawnOverride?: RpcChildRunInput["spawnOverride"];
  skipChildRuntime?: RpcChildRunInput["skipChildRuntime"];
  projectTrusted?: boolean;
  hasUI?: boolean;
  requestProfileApproval?: (profile: ProfileDefinition) => Promise<boolean>;
}

export type BackgroundCompleteHandler = (result: SubagentRunResult) => void | boolean;

interface PreparedSubagentRun {
  runId: string;
  profile: ProfileDefinition;
  modelArg: string;
  abortController: AbortController;
  linkedSignal: AbortSignal | undefined;
  taskPreview: string;
  timeoutMs: number;
}

export interface SubagentSupervisorOptions {
  artifactRoot?: string;
}

const RECOVERY_BLOCK_MAX_BYTES = 4_096;

function formatRecoveryBlock(delivery: WorktreeDelivery): string | undefined {
  const lines: string[] = [];
  if (delivery.error) lines.push(`Finalization error: ${delivery.error}`);
  if (delivery.retainedWorktreePath) lines.push(`Retained worktree: ${delivery.retainedWorktreePath}`);
  if (delivery.branch) lines.push(`Branch: ${delivery.branch}`);
  if (delivery.patch?.path) lines.push(`Patch: ${delivery.patch.path}`);
  if (!lines.length) return undefined;
  return truncateUtf8(`## Recovery\n${lines.join("\n")}`, RECOVERY_BLOCK_MAX_BYTES);
}

function formatRecoveryErrorSummary(delivery: WorktreeDelivery): string | undefined {
  const parts: string[] = [];
  if (delivery.error) parts.push(delivery.error);
  if (delivery.retainedWorktreePath) parts.push(`retained=${delivery.retainedWorktreePath}`);
  if (delivery.branch) parts.push(`branch=${delivery.branch}`);
  if (delivery.patch?.path) parts.push(`patch=${delivery.patch.path}`);
  return parts.length ? parts.join("; ") : undefined;
}

function hasRecoveryFailure(delivery: WorktreeDelivery): boolean {
  return Boolean(delivery.error || delivery.retainedWorktreePath);
}

export class SubagentSupervisor {
  private readonly catalog: ProfileCatalog;
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly artifactRoot: string;
  private readonly tracker: DetachedChildTracker = createDetachedChildTracker();
  private readonly runs = new RunStore();
  private readonly pendingDelivery = createDeferredResultDelivery<SubagentRunResult>();
  private activeRuns = 0;
  private sessionRunCount = 0;
  private sessionCostUsd = 0;
  private sessionSoftCostUsd = SESSION_SOFT_COST_USD;
  private costWarned = false;
  private onBackgroundComplete?: BackgroundCompleteHandler;
  private disposed = false;

  constructor(cwd: string, agentDir?: string, options?: SubagentSupervisorOptions) {
    this.cwd = cwd;
    this.catalog = new ProfileCatalog(cwd, agentDir);
    this.agentDir = this.catalog.getAgentDir();
    this.artifactRoot = options?.artifactRoot ?? getDefaultArtifactRoot();
    pruneStalePatchArtifacts(this.artifactRoot);
    this.reloadCostSettings();
  }

  setBackgroundCompleteHandler(handler: BackgroundCompleteHandler | undefined): void {
    if (this.disposed) return;
    this.onBackgroundComplete = handler;
  }

  reloadProfiles(): void {
    this.catalog.reload();
    this.reloadCostSettings();
  }

  private reloadCostSettings(): void {
    const settings = this.catalog.getSettings();
    this.sessionSoftCostUsd = settings.sessionSoftCostUsd ?? SESSION_SOFT_COST_USD;
  }

  dispose(): void {
    this.disposed = true;
    this.onBackgroundComplete = undefined;
    this.pendingDelivery.clear();
    this.runs.clear();
    this.tracker.dispose();
    pruneStalePatchArtifacts(this.artifactRoot);
    pruneStaleWorktrees(this.cwd);
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  getSessionCostUsd(): number {
    return this.sessionCostUsd;
  }

  getSessionSoftCostUsd(): number {
    return this.sessionSoftCostUsd;
  }

  shouldWarnCost(): boolean {
    return this.sessionCostUsd >= this.sessionSoftCostUsd * SESSION_COST_WARN_RATIO;
  }

  markCostWarned(): void {
    this.costWarned = true;
  }

  needsCostWarning(): boolean {
    return this.shouldWarnCost() && !this.costWarned;
  }

  getProfileLoadDiagnostics(): readonly string[] {
    return this.catalog.getLoadDiagnostics();
  }

  listProfiles(): ProfileDefinition[] {
    return this.catalog.list();
  }

  listRuns() {
    return this.runs.list();
  }

  getRun(runId: string) {
    return this.runs.get(runId);
  }

  pendingBackgroundRunIds(): string[] {
    return this.pendingDelivery.pendingRunIds();
  }

  cancelRun(runId: string, reason?: string): boolean {
    return this.runs.cancel(runId, reason);
  }

  drainPendingResults(): void {
    if (this.disposed) return;
    for (const runId of this.pendingDelivery.pendingRunIds()) {
      this.attemptBackgroundDelivery(runId);
    }
  }

  async applyPatch(runId: string): Promise<SubagentRunResult> {
    const record = this.runs.get(runId);
    if (!record?.result) {
      throw new Error(`No completed subagent run "${runId}" in this session`);
    }
    if (record.status === "running") {
      throw new Error(`Subagent run "${runId}" is still running`);
    }

    const delivery = record.result.worktreeDelivery;
    if (!delivery?.patch) {
      throw new Error(`Run "${runId}" has no patch artifact to apply`);
    }
    if (!delivery.branch) {
      throw new Error(`Run "${runId}" has no durable worktree branch`);
    }

    const outcome = await applyVerifiedPatch({
      repoRoot: delivery.repoRoot,
      patch: delivery.patch,
    });

    const applyStatus: PatchApplyStatus = outcome.ok ? outcome.status : "failed";
    const updatedDelivery: WorktreeDelivery = {
      ...delivery,
      patch: {
        ...delivery.patch,
        applyStatus,
      },
    };

    const priorError = record.result.error;
    const composedError = outcome.ok
      ? priorError
      : [priorError, outcome.error].filter(Boolean).join("; ");

    const updated: SubagentRunResult = {
      ...record.result,
      status: outcome.ok ? record.result.status : "failed",
      worktreeDelivery: updatedDelivery,
      worktreeBranch: updatedDelivery.branch,
      error: composedError,
    };

    record.result = updated;
    record.status = updated.status;
    record.worktreeDelivery = updatedDelivery;
    record.worktreeBranch = updatedDelivery.branch;

    if (!outcome.ok) {
      throw new Error(outcome.error);
    }

    return updated;
  }

  async run(input: SupervisorRunInput): Promise<SubagentRunResult> {
    if (this.disposed) {
      throw new Error("SubagentSupervisor has been disposed");
    }
    if (input.mode === "background") {
      return this.startBackground(input);
    }
    return this.runForeground(input);
  }

  private queueBackgroundResult(result: SubagentRunResult): void {
    if (this.disposed) return;
    this.pendingDelivery.defer(result);
    this.attemptBackgroundDelivery(result.runId);
  }

  private attemptBackgroundDelivery(runId: string): boolean {
    if (this.disposed || !this.onBackgroundComplete) return false;

    const claimed = this.pendingDelivery.claim(runId);
    if (!claimed) return false;

    try {
      const delivered = this.onBackgroundComplete(claimed);
      if (delivered === false) {
        this.pendingDelivery.restore(claimed);
        return false;
      }
      this.pendingDelivery.confirm(runId);
      return true;
    } catch {
      this.pendingDelivery.restore(claimed);
      return false;
    }
  }

  private async startBackground(input: SupervisorRunInput): Promise<SubagentRunResult> {
    const prepared = await this.prepareRun(input);
    const record = this.runs.register({
      runId: prepared.runId,
      profile: prepared.profile.name,
      qualifiedProfile: prepared.profile.qualifiedId,
      taskPreview: prepared.taskPreview,
      mode: "background",
      abortController: prepared.abortController,
    });

    const promise = this.executeRun(prepared, input);
    void promise
      .then((result) => {
        if (this.disposed) return;
        this.runs.complete(prepared.runId, result);
        this.queueBackgroundResult(result);
      })
      .catch((error) => {
        if (this.disposed) return;
        const failed = this.composeRunResult(prepared, Date.now(), undefined, error, undefined);
        this.runs.complete(prepared.runId, failed);
        this.queueBackgroundResult(failed);
      });

    return {
      runId: prepared.runId,
      profile: prepared.profile.name,
      qualifiedProfile: prepared.profile.qualifiedId,
      status: "running",
      report: `Background subagent ${prepared.runId} started (${prepared.profile.qualifiedId}).`,
      usage: emptyUsage(),
      durationMs: 0,
    };
  }

  private async runForeground(input: SupervisorRunInput): Promise<SubagentRunResult> {
    const prepared = await this.prepareRun(input);
    this.runs.register({
      runId: prepared.runId,
      profile: prepared.profile.name,
      qualifiedProfile: prepared.profile.qualifiedId,
      taskPreview: prepared.taskPreview,
      mode: "foreground",
      abortController: prepared.abortController,
    });

    const result = await this.executeRun(prepared, input);
    this.runs.complete(prepared.runId, result);
    return result;
  }

  private async prepareRun(input: SupervisorRunInput): Promise<PreparedSubagentRun> {
    if (this.sessionRunCount >= MAX_SESSION_RUNS) {
      throw new Error(
        `Session subagent limit reached (${MAX_SESSION_RUNS} runs). Start a new session to continue.`,
      );
    }
    if (this.activeRuns >= MAX_CONCURRENT_RUNS) {
      throw new Error(
        `Too many concurrent subagents (max ${MAX_CONCURRENT_RUNS}). Wait for running subagents to finish.`,
      );
    }

    this.activeRuns++;

    try {
      const profile = this.catalog.resolve(input.profile);
      await ensureProjectProfileAllowed(
        profile,
        {
          projectTrusted: input.projectTrusted ?? false,
          hasUI: input.hasUI ?? false,
          requestApproval: input.requestProfileApproval,
        },
        this.agentDir,
      );
      const modelArg = resolveProfileModelArg(profile, input.parentModel);
      const runId = `sa-${randomUUID().slice(0, 8)}`;
      this.sessionRunCount++;

      const linkedSignal = input.signal;
      const abortController = new AbortController();
      if (linkedSignal) {
        if (linkedSignal.aborted) abortController.abort();
        else linkedSignal.addEventListener("abort", () => abortController.abort(), { once: true });
      }

      const taskPreview =
        input.task.length > 80 ? `${input.task.slice(0, 80)}…` : input.task;

      return {
        runId,
        profile,
        modelArg,
        abortController,
        linkedSignal,
        taskPreview,
        timeoutMs: input.timeoutMs ?? profile.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      };
    } catch (error) {
      this.activeRuns--;
      throw error;
    }
  }

  private composeRunResult(
    prepared: PreparedSubagentRun,
    started: number,
    output: Awaited<ReturnType<typeof runRpcChild>> | undefined,
    executeError: unknown,
    worktreeDelivery: WorktreeDelivery | undefined,
  ): SubagentRunResult {
    const recoveryBlock = worktreeDelivery ? formatRecoveryBlock(worktreeDelivery) : undefined;
    const recoveryErrorSummary = worktreeDelivery
      ? formatRecoveryErrorSummary(worktreeDelivery)
      : undefined;
    const recoveryFailed = worktreeDelivery ? hasRecoveryFailure(worktreeDelivery) : false;
    const infraError = executeError instanceof Error ? executeError.message : executeError
      ? String(executeError)
      : undefined;

    let status: RunTerminalStatus = "completed";
    // Structured child reports with status blocked/failed are completed runs, not supervisor failures.
    if (recoveryFailed || infraError) {
      status = "failed";
    } else if (output) {
      if (prepared.abortController.signal.aborted || prepared.linkedSignal?.aborted) {
        status = output.budgetExhausted ? "failed" : "cancelled";
      } else if (output.budgetExhausted) {
        status = "failed";
      } else if (output.error?.includes("timed out")) {
        status = "timed_out";
      } else if (!output.settled || output.error) {
        status = "failed";
      } else if (output.exitCode !== null && output.exitCode !== 0) {
        status = "failed";
      }
    } else {
      status = "failed";
    }

    const bodyParts: string[] = [];
    if (recoveryBlock) bodyParts.push(recoveryBlock);
    if (output?.reportText.trim()) {
      bodyParts.push(output.reportText.trim());
    } else if (infraError) {
      bodyParts.push(infraError);
    } else if (!recoveryBlock) {
      bodyParts.push("(no output)");
    }

    const errorParts = [infraError, recoveryErrorSummary].filter(Boolean);
    const combinedError = errorParts.length > 0 ? errorParts.join("; ") : output?.error;

    return {
      runId: prepared.runId,
      profile: prepared.profile.name,
      qualifiedProfile: prepared.profile.qualifiedId,
      status,
      report: truncateUtf8(bodyParts.join("\n\n"), REPORT_MAX_BYTES),
      semanticReport: output?.semanticReport,
      usage: output?.usage ?? emptyUsage(),
      model: prepared.modelArg,
      error: status === "completed" ? undefined : combinedError,
      durationMs: Date.now() - started,
      worktreeBranch: worktreeDelivery?.branch,
      worktreeDelivery,
      budgetExhausted: output?.budgetExhausted,
    };
  }

  private async executeRun(
    prepared: PreparedSubagentRun,
    input: SupervisorRunInput,
  ): Promise<SubagentRunResult> {
    const started = Date.now();
    let worktree: WorktreeInfo | undefined;
    let worktreeDelivery: WorktreeDelivery | undefined;
    let workCwd = input.cwd;
    let output: Awaited<ReturnType<typeof runRpcChild>> | undefined;
    let executeError: unknown;

    try {
      if (prepared.profile.workspace === "worktree") {
        worktree = createWorktree(input.cwd, prepared.runId);
        if (!worktree) {
          throw new Error(
            `Profile "${prepared.profile.qualifiedId}" requires a git worktree but none could be created`,
          );
        }
        workCwd = worktree.workPath;
      }

      output = await runRpcChild({
        cwd: workCwd,
        profile: prepared.profile,
        modelArg: prepared.modelArg,
        prompt: buildTaskPrompt(prepared.profile.name, input.task, input.context),
        timeoutMs: prepared.timeoutMs,
        signal: prepared.abortController.signal,
        tracker: this.tracker,
        spawnOverride: input.spawnOverride,
        skipChildRuntime: input.skipChildRuntime,
        onActivity: (name) => {
          this.runs.updateActivity(prepared.runId, name);
          input.onActivity?.(name);
        },
      });

      this.sessionCostUsd += output.usage.cost;
    } catch (error) {
      executeError = error;
    } finally {
      try {
        if (worktree) {
          const finalized = await finalizeWorktree(worktree, {
            description: input.task,
            runId: prepared.runId,
            artifactRoot: this.artifactRoot,
          });
          worktreeDelivery = finalized.delivery;
        }
      } finally {
        this.activeRuns--;
      }
    }

    return this.composeRunResult(prepared, started, output, executeError, worktreeDelivery);
  }
}

export function formatRunSummary(result: SubagentRunResult): string {
  const parts = [
    `[${result.profile}] ${result.status}`,
    `${result.durationMs}ms`,
    `$${result.usage.cost.toFixed(4)}`,
  ];
  if (result.usage.turns) parts.push(`${result.usage.turns} turns`);
  if (result.semanticReport?.kind === "structured") {
    parts.push(`report:${result.semanticReport.report.status}`);
  } else if (result.semanticReport?.kind === "unstructured") {
    parts.push("report:unstructured");
  }
  if (result.worktreeBranch) parts.push(`branch:${result.worktreeBranch}`);
  if (result.worktreeDelivery?.patch) parts.push(`patch:${result.worktreeDelivery.patch.applyStatus}`);
  if (result.budgetExhausted) parts.push("budget-exhausted");
  return parts.join(" · ");
}
