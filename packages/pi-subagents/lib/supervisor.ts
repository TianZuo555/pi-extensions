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
import { createDeferredResultDelivery } from "./result-delivery.ts";
import { runRpcChild, type RpcChildRunInput } from "./rpc-child.ts";
import { RunStore } from "./run-store.ts";
import { cleanupWorktree, createWorktree, pruneStaleWorktrees, type WorktreeInfo } from "./worktree.ts";
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
  projectTrusted?: boolean;
  hasUI?: boolean;
  requestProfileApproval?: (profile: ProfileDefinition) => Promise<boolean>;
}

export type BackgroundCompleteHandler = (result: SubagentRunResult) => void;

interface PreparedSubagentRun {
  runId: string;
  profile: ProfileDefinition;
  modelArg: string;
  abortController: AbortController;
  linkedSignal: AbortSignal | undefined;
  taskPreview: string;
  timeoutMs: number;
}

export class SubagentSupervisor {
  private readonly catalog: ProfileCatalog;
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly tracker: DetachedChildTracker = createDetachedChildTracker();
  private readonly runs = new RunStore();
  private readonly pendingDelivery = createDeferredResultDelivery<SubagentRunResult>();
  private activeRuns = 0;
  private sessionRunCount = 0;
  private sessionCostUsd = 0;
  private sessionSoftCostUsd = SESSION_SOFT_COST_USD;
  private costWarned = false;
  private onBackgroundComplete?: BackgroundCompleteHandler;

  constructor(cwd: string, agentDir?: string) {
    this.cwd = cwd;
    this.catalog = new ProfileCatalog(cwd, agentDir);
    this.agentDir = this.catalog.getAgentDir();
    this.reloadCostSettings();
  }

  setBackgroundCompleteHandler(handler: BackgroundCompleteHandler | undefined): void {
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
    this.runs.clear();
    this.pendingDelivery.clear();
    this.tracker.dispose();
    pruneStaleWorktrees(this.cwd);
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

  cancelRun(runId: string, reason?: string): boolean {
    return this.runs.cancel(runId, reason);
  }

  drainPendingResults(): SubagentRunResult[] {
    return this.pendingDelivery.drain();
  }

  async run(input: SupervisorRunInput): Promise<SubagentRunResult> {
    if (input.mode === "background") {
      return this.startBackground(input);
    }
    return this.runForeground(input);
  }

  private failedResult(
    prepared: PreparedSubagentRun,
    startedAt: number,
    error: unknown,
  ): SubagentRunResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
      runId: prepared.runId,
      profile: prepared.profile.name,
      qualifiedProfile: prepared.profile.qualifiedId,
      status: "failed",
      report: truncateUtf8(message, REPORT_MAX_BYTES),
      usage: emptyUsage(),
      model: prepared.modelArg,
      error: message,
      durationMs: Date.now() - startedAt,
    };
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
        this.runs.complete(prepared.runId, result);
        this.pendingDelivery.defer(result);
        this.onBackgroundComplete?.(result);
      })
      .catch((error) => {
        const failed = this.failedResult(prepared, record.startedAt, error);
        this.runs.complete(prepared.runId, failed);
        this.pendingDelivery.defer(failed);
        this.onBackgroundComplete?.(failed);
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
    const record = this.runs.register({
      runId: prepared.runId,
      profile: prepared.profile.name,
      qualifiedProfile: prepared.profile.qualifiedId,
      taskPreview: prepared.taskPreview,
      mode: "foreground",
      abortController: prepared.abortController,
    });

    try {
      const result = await this.executeRun(prepared, input);
      this.runs.complete(prepared.runId, result);
      return result;
    } catch (error) {
      const failed = this.failedResult(prepared, record.startedAt, error);
      this.runs.complete(prepared.runId, failed);
      return failed;
    }
  }

  private async prepareRun(input: SupervisorRunInput): Promise<PreparedSubagentRun> {
    if (this.sessionRunCount >= MAX_SESSION_RUNS) {
      throw new Error(
        `Session subagent limit reached (${MAX_SESSION_RUNS} runs). Start a new session to delegate more work.`,
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

  private async executeRun(
    prepared: PreparedSubagentRun,
    input: SupervisorRunInput,
  ): Promise<SubagentRunResult> {
    const started = Date.now();

    let worktree: WorktreeInfo | undefined;
    let workCwd = input.cwd;

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

      const output = await runRpcChild({
        cwd: workCwd,
        profile: prepared.profile,
        modelArg: prepared.modelArg,
        prompt: buildTaskPrompt(prepared.profile.name, input.task, input.context),
        timeoutMs: prepared.timeoutMs,
        signal: prepared.abortController.signal,
        tracker: this.tracker,
        spawnOverride: input.spawnOverride,
        onActivity: (name) => {
          this.runs.updateActivity(prepared.runId, name);
          input.onActivity?.(name);
        },
      });

      this.sessionCostUsd += output.usage.cost;

      let worktreeBranch: string | undefined;
      if (worktree) {
        const cleanup = cleanupWorktree(worktree, input.task);
        if (cleanup.hasChanges && cleanup.branch) worktreeBranch = cleanup.branch;
      }

      let status: RunTerminalStatus = "completed";
      if (prepared.abortController.signal.aborted || prepared.linkedSignal?.aborted) {
        status = "cancelled";
      } else if (output.error?.includes("timed out")) status = "timed_out";
      else if (!output.settled || output.error) status = "failed";
      else if (output.exitCode !== null && output.exitCode !== 0) status = "failed";

      const report = truncateUtf8(
        output.reportText.trim() || output.stderr.trim() || "(no output)",
        REPORT_MAX_BYTES,
      );

      return {
        runId: prepared.runId,
        profile: prepared.profile.name,
        qualifiedProfile: prepared.profile.qualifiedId,
        status,
        report,
        usage: output.usage,
        model: prepared.modelArg,
        error: status === "completed" ? undefined : output.error,
        durationMs: Date.now() - started,
        worktreeBranch,
      };
    } finally {
      this.activeRuns--;
    }
  }
}

export function formatRunSummary(result: SubagentRunResult): string {
  const parts = [
    `[${result.profile}] ${result.status}`,
    `${result.durationMs}ms`,
    `$${result.usage.cost.toFixed(4)}`,
  ];
  if (result.usage.turns) parts.push(`${result.usage.turns} turns`);
  if (result.worktreeBranch) parts.push(`branch:${result.worktreeBranch}`);
  return parts.join(" · ");
}
