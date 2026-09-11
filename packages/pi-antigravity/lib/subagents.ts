/**
 * Subagent roster — folds agy's subagent tool calls into a live list for
 * `/agy-subagents`. agy has no read-only subcommand or slash command for live
 * subagent state (`/subagents` expands to a model turn), so the only zero-token
 * source is the stream itself: `invoke_subagent`/`run_subagent`/
 * `define_subagent`/`browser_subagent` spawns arrive as ordinary tool steps
 * (ACTIVE → DONE/ERROR), `send_message` addresses a spawned agent, and
 * `manage_subagents` carries lifecycle actions (kill/…). Tracking is
 * best-effort: entries describe observed tool activity, not agy's internal
 * hub state.
 */

import type { AgyActivity } from "./reducer.ts";
import { agyToolStepKey } from "./tool-steps.ts";

export type AgySubagentStatus = "running" | "done" | "error" | "killed";

export interface AgySubagentEntry {
  key: string;
  /** Subagent name from the call args, or the tool name when absent. */
  name: string;
  /** Tool that produced the entry (`invoke_subagent`, `run_subagent`, …). */
  tool: string;
  status: AgySubagentStatus;
  startedAtMs: number;
  /** agy-reported duration once the step completes. */
  durationSeconds?: number;
  /** Task/prompt summary when the call carried one. */
  detail?: string;
  /** `send_message` calls addressed to this entry. */
  messages: number;
  error?: string;
}

const SPAWN_TOOLS = new Set([
  "invoke_subagent",
  "run_subagent",
  "define_subagent",
  "browser_subagent",
]);
const MESSAGE_TOOLS = new Set(["send_message"]);
const MANAGE_TOOLS = new Set(["manage_subagents"]);

/** True for tool names in agy's subagent orchestration family. */
export function isAgySubagentTool(name: string): boolean {
  return SPAWN_TOOLS.has(name) || MESSAGE_TOOLS.has(name) || MANAGE_TOOLS.has(name);
}

/** First defined non-empty string among the given keys (agy mixes key casings). */
function pickArg(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function pickName(args: Record<string, unknown>, tool: string): string {
  return (
    pickArg(args, [
      "Name",
      "name",
      "Subagent",
      "subagent",
      "subagent_name",
      "SubagentName",
      "Agent",
      "agent",
      "Type",
      "type",
    ]) ?? tool
  );
}

function pickDetail(args: Record<string, unknown>): string | undefined {
  const detail = pickArg(args, [
    "Task",
    "task",
    "Prompt",
    "prompt",
    "Instruction",
    "instruction",
    "Instructions",
    "Goal",
    "goal",
    "Description",
    "description",
    "Message",
    "message",
  ]);
  return detail?.replace(/\s+/g, " ").slice(0, 120);
}

/** Case-insensitive lookup by subagent name (send/manage steps carry no step id). */
function findByName(
  roster: Map<string, AgySubagentEntry>,
  name: string,
): AgySubagentEntry | undefined {
  const needle = name.toLowerCase();
  for (const entry of roster.values()) {
    if (entry.name.toLowerCase() === needle) return entry;
  }
  return undefined;
}

/** Fold one stream activity into the roster; ignores non-tool activities. */
export function trackAgySubagent(
  roster: Map<string, AgySubagentEntry>,
  activity: AgyActivity,
  now = Date.now(),
): void {
  if (
    activity.type !== "tool_start" &&
    activity.type !== "tool_done" &&
    activity.type !== "tool_error"
  ) {
    return;
  }
  const { name: tool, args } = activity;

  if (MESSAGE_TOOLS.has(tool)) {
    if (activity.type !== "tool_start") return;
    const target = pickArg(args, [
      "To",
      "to",
      "Target",
      "target",
      "Subagent",
      "subagent",
      "Name",
      "name",
    ]);
    const entry = target ? findByName(roster, target) : undefined;
    if (entry) entry.messages += 1;
    return;
  }

  if (MANAGE_TOOLS.has(tool)) {
    if (activity.type !== "tool_start") return;
    const action = (
      pickArg(args, ["Action", "action", "Operation", "operation"]) ?? ""
    ).toLowerCase();
    if (!/kill|stop|terminat|cancel|abort/.test(action)) return;
    const target = pickArg(args, [
      "Name",
      "name",
      "Subagent",
      "subagent",
      "subagent_id",
      "SubagentId",
      "Id",
      "id",
    ]);
    if (target) {
      const entry = findByName(roster, target);
      if (entry && entry.status === "running") entry.status = "killed";
      return;
    }
    for (const entry of roster.values()) {
      if (entry.status === "running") entry.status = "killed";
    }
    return;
  }

  if (!SPAWN_TOOLS.has(tool)) return;
  const key = agyToolStepKey({ stepId: activity.stepId, name: `${tool}:${pickName(args, tool)}` });
  if (activity.type === "tool_start") {
    if (!roster.has(key)) {
      roster.set(key, {
        key,
        name: pickName(args, tool),
        tool,
        status: "running",
        startedAtMs: now,
        detail: pickDetail(args),
        messages: 0,
      });
    }
    return;
  }
  const entry = roster.get(key);
  if (!entry) return;
  if (activity.type === "tool_done") {
    if (entry.status === "running") entry.status = "done";
    if (entry.durationSeconds === undefined) {
      entry.durationSeconds = activity.durationSeconds;
    }
  } else {
    entry.status = "error";
    entry.error = activity.message;
  }
}

function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/** One line per entry plus a header; empty roster returns undefined. */
export function formatAgySubagents(
  roster: Map<string, AgySubagentEntry>,
  now = Date.now(),
): string | undefined {
  const entries = [...roster.values()];
  if (entries.length === 0) return undefined;
  const running = entries.filter((entry) => entry.status === "running").length;
  const lines = [
    `antigravity subagents: ${entries.length} tracked${running ? ` · ${running} running` : ""}`,
  ];
  for (const entry of entries) {
    const elapsed = entry.durationSeconds ?? Math.max(0, (now - entry.startedAtMs) / 1000);
    const parts = [
      `• ${entry.name}`,
      entry.status,
      formatElapsed(elapsed),
      entry.messages > 0 ? `${entry.messages} msg${entry.messages === 1 ? "" : "s"}` : undefined,
      entry.detail ? `"${entry.detail}"` : undefined,
      entry.error,
    ].filter((part): part is string => part !== undefined);
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}
