import type { BackendRunInput, BackendRunOutput, SubagentBackend } from "./backend.ts";
import { createDetachedChildTracker, type DetachedChildTracker } from "./process-tracker.ts";
import { runRpcChild } from "./rpc-child.ts";

export class RpcSubagentBackend implements SubagentBackend {
  readonly id = "rpc";
  private tracker: DetachedChildTracker;

  constructor() {
    this.tracker = createDetachedChildTracker();
  }

  async run(input: BackendRunInput): Promise<BackendRunOutput> {
    const output = await runRpcChild({
      cwd: input.cwd,
      profile: input.profile,
      modelArg: input.modelArg,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      tracker: this.tracker,
      spawnOverride: input.rpcOverrides?.spawnOverride,
      skipChildRuntime: input.rpcOverrides?.skipChildRuntime,
      onActivity: input.onActivity,
    });

    return {
      settled: output.settled,
      reportText: output.reportText,
      semanticReport: output.semanticReport,
      usage: output.usage,
      usageAvailable: true,
      error: output.error,
      exitCode: output.exitCode,
      budgetExhausted: output.budgetExhausted,
      terminalReportReceived: output.terminalReportReceived,
    };
  }

  async cancel(_runId: string, _reason?: string): Promise<void> {
    // RPC cancellation flows through the AbortSignal passed to run().
  }

  async dispose(): Promise<void> {
    this.tracker.dispose();
  }
}
