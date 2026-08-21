/** Shared domain types for pi-subagents. */

import type { ChildSemanticReport } from "./run-report.ts";
import type { WorktreeDelivery } from "./worktree.ts";

export const BUILTIN_PROFILE_NAMES = [
  "scout",
  "planner",
  "reviewer",
  "oracle",
  "worker",
] as const;

export type BuiltinProfileName = (typeof BUILTIN_PROFILE_NAMES)[number];

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const MUTATING_TOOLS = ["write", "edit", "bash"] as const;
export const ALL_ALLOWED_TOOLS = [...READ_ONLY_TOOLS, ...MUTATING_TOOLS] as const;

export type ProfileSource = "builtin" | "user" | "project";

export type WorkspacePolicy = "shared-readonly" | "shared-write" | "worktree";

export type RunTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type RunLifecycleStatus = RunTerminalStatus | "running";

export type RunMode = "foreground" | "background";

export const SUPPORTED_AGENT_KINDS = [
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "maki",
] as const;

export type AgentKind = (typeof SUPPORTED_AGENT_KINDS)[number];

export type SubagentBackendKind = "auto" | "herdr" | "rpc";

export interface ProfileDefinition {
  /** e.g. builtin/scout, user/my-agent, project/scout */
  qualifiedId: string;
  name: string;
  source: ProfileSource;
  description: string;
  tools: readonly string[];
  /** Raw model from frontmatter or override; resolved at spawn */
  modelRef?: string;
  systemPrompt: string;
  workspace: WorkspacePolicy;
  timeoutMs: number;
  /** Thinking level suffix for --model provider/id:level */
  thinkingRef?: string;
  /** Disk path when loaded from user/project agents dir */
  filePath?: string;
  /** SHA-256 prefix of raw profile file bytes (project trust gate) */
  contentHash?: string;
  /** Soft live-turn budget enforced via RPC turn_start events */
  maxTurns: number;
  kind: AgentKind;
  backend: SubagentBackendKind;
  agentArgs: readonly string[];
}

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface SubagentRunResult {
  runId: string;
  profile: string;
  qualifiedProfile: string;
  status: RunLifecycleStatus;
  report: string;
  usage: RunUsage;
  usageAvailable?: boolean;
  model?: string;
  error?: string;
  durationMs: number;
  worktreeBranch?: string;
  semanticReport?: ChildSemanticReport;
  worktreeDelivery?: WorktreeDelivery;
  budgetExhausted?: boolean;
  profileKind?: AgentKind;
  backendId?: "rpc" | "herdr";
  herdr?: {
    paneId: string;
    alias: string;
    workspaceId?: string;
    agentStatus?: string;
  };
}

export interface RunRecord {
  runId: string;
  profile: string;
  qualifiedProfile: string;
  taskPreview: string;
  mode: RunMode;
  status: RunLifecycleStatus;
  startedAt: number;
  completedAt?: number;
  activity?: string;
  result?: SubagentRunResult;
  worktreeBranch?: string;
  worktreeDelivery?: WorktreeDelivery;
  cancelReason?: string;
  profileKind?: AgentKind;
  backendId?: "rpc" | "herdr";
  herdr?: SubagentRunResult["herdr"];
}

export interface SubagentToolDetails {
  runId: string;
  profile: string;
  status: RunLifecycleStatus | RunTerminalStatus;
  usage: RunUsage;
  usageAvailable?: boolean;
  model?: string;
  activity?: string;
  mode?: RunMode;
  semanticReport?: ChildSemanticReport;
  worktreeDelivery?: WorktreeDelivery;
  budgetExhausted?: boolean;
}

export const TASK_MAX_LENGTH = 16 * 1024;
export const CONTEXT_MAX_LENGTH = 32 * 1024;
export const REPORT_MAX_BYTES = 32 * 1024;
export const TRUNCATION_MARKER = "…[truncated]";
export const MAX_CONCURRENT_RUNS = 4;
export const MAX_SESSION_RUNS = 20;
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_TURNS = 8;
export const MAX_PROFILE_TURNS = 100;
export const SESSION_SOFT_COST_USD = 5;
export const SESSION_COST_WARN_RATIO = 0.8;
export const BACKGROUND_RESULT_TYPE = "subagent-result";

export function emptyUsage(): RunUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function truncateText(text: string, maxCodeUnits: number): string {
  if (text.length <= maxCodeUnits) return text;
  const budget = maxCodeUnits - TRUNCATION_MARKER.length;
  if (budget < 1) return TRUNCATION_MARKER;
  return text.slice(0, budget) + TRUNCATION_MARKER;
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  let budget = maxBytes - markerBytes;
  if (budget < 1) return TRUNCATION_MARKER;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > budget) {
    end--;
  }
  return text.slice(0, end) + TRUNCATION_MARKER;
}

export function isTerminalStatus(status: RunLifecycleStatus): status is RunTerminalStatus {
  return status !== "running";
}

export function parseWorkspacePolicy(raw: unknown): WorkspacePolicy {
  const value = String(raw ?? "shared-readonly").trim();
  if (value === "shared-readonly" || value === "shared-write" || value === "worktree") {
    return value;
  }
  return "shared-readonly";
}
