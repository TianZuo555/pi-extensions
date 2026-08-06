import type { ProfileDefinition, RunUsage } from "./domain.ts";
import type { ChildSemanticReport } from "./run-report.ts";
import type { WorktreeInfo } from "./worktree.ts";

export interface BackendRunInput {
  runId: string;
  profile: ProfileDefinition;
  cwd: string;
  prompt: string;
  modelArg?: string;
  timeoutMs: number;
  signal: AbortSignal;
  onActivity?: (activity: string) => void;
  /** Herdr backend task text (supervisor passes in phase 6). */
  task?: string;
  context?: string;
  rpcOverrides?: {
    spawnOverride?: { command: string; args: string[] };
    skipChildRuntime?: boolean;
  };
}

export interface BackendRunOutput {
  settled: boolean;
  reportText: string;
  semanticReport: ChildSemanticReport;
  usage: RunUsage;
  usageAvailable: boolean;
  error?: string;
  exitCode?: number | null;
  budgetExhausted?: boolean;
  terminalReportReceived?: boolean;
  herdr?: { paneId: string; alias: string; workspaceId?: string; agentStatus?: string };
  /** Populated by the Herdr backend when it created an isolated worktree for this run. */
  worktree?: WorktreeInfo;
}

export interface SubagentBackend {
  readonly id: "rpc" | "herdr";
  run(input: BackendRunInput): Promise<BackendRunOutput>;
  cancel(runId: string, reason?: string): Promise<void>;
  dispose(): Promise<void>;
}
