import type {
  RunLifecycleStatus,
  RunMode,
  RunRecord,
  SubagentRunResult,
} from "./domain.ts";

export class RunStore {
  private runs = new Map<string, RunRecord>();
  private readonly abortControllers = new Map<string, AbortController>();

  register(input: {
    runId: string;
    profile: string;
    qualifiedProfile: string;
    taskPreview: string;
    mode: RunMode;
    abortController: AbortController;
  }): RunRecord {
    const record: RunRecord = {
      runId: input.runId,
      profile: input.profile,
      qualifiedProfile: input.qualifiedProfile,
      taskPreview: input.taskPreview,
      mode: input.mode,
      status: "running",
      startedAt: Date.now(),
    };
    this.runs.set(input.runId, record);
    this.abortControllers.set(input.runId, input.abortController);
    return record;
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  updateActivity(runId: string, activity: string): void {
    const record = this.runs.get(runId);
    if (record) record.activity = activity;
  }

  complete(runId: string, result: SubagentRunResult): RunRecord | undefined {
    const record = this.runs.get(runId);
    if (!record) return undefined;
    if (record.status === "cancelled") {
      result.status = "cancelled";
      result.error = record.cancelReason ?? result.error ?? "cancelled by user";
    }
    record.status = result.status;
    record.completedAt = Date.now();
    record.result = result;
    record.worktreeBranch = result.worktreeBranch;
    this.abortControllers.delete(runId);
    return record;
  }

  cancel(runId: string, reason?: string): boolean {
    const controller = this.abortControllers.get(runId);
    if (!controller) return false;
    controller.abort();
    const record = this.runs.get(runId);
    if (record && record.status === "running") {
      record.status = "cancelled";
      record.cancelReason = reason ?? "cancelled by user";
    }
    return true;
  }

  clear(): void {
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
    this.runs.clear();
  }
}
