/**
 * /devin-usage — render the usage devin reports over ACP (usage_update
 * counters/cost + agent_stopped response dimensions) in /usage's report
 * style: padded label column, a block bar for context occupancy, grouped
 * sections. ACP has no pull-based usage request, so the report renders the
 * latest pushed snapshot; Refresh re-reads it (useful while a turn runs).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DevinStateSnapshot } from "./runtime.ts";
import type { DevinResponseDimension, DevinTurnStats, DevinUsage } from "./turn.ts";

const BAR_SEGMENTS = 20;
const LABEL_COLUMN = 22;
const REFRESH = "Refresh";
const CLOSE = "Close";

interface UsageRow {
  /** Section header the row belongs to (server-provided for dimensions). */
  group?: string;
  label: string;
  value: string;
}

function bar(percentUsed: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, percentUsed)) / 100) * BAR_SEGMENTS);
  return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}]`;
}

function formatCount(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) >= 1000) return rounded.toLocaleString("en-US");
  return String(rounded);
}

/** Fractional counters (credits/ACUs) keep up to 4 decimals, trimmed. */
function formatAmount(value: number): string {
  if (Number.isInteger(value)) return formatCount(value);
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Format one server-reported dimension (metric string or cumulativeMetric). */
function dimensionValue(dim: DevinResponseDimension): string | undefined {
  const kind = dim.kind;
  if (!kind || kind.value === undefined || kind.value === null) return undefined;
  if (typeof kind.value === "number") {
    const tail = kind.value === 1 ? (kind.tail ?? "") : (kind.pluralTail ?? kind.tail ?? "");
    return `${kind.prefix ?? ""}${formatAmount(kind.value)}${tail}`;
  }
  return String(kind.value);
}

function dimensionRows(dims: DevinResponseDimension[] | undefined): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const dim of dims ?? []) {
    const value = dimensionValue(dim);
    if (dim.label && value !== undefined) {
      rows.push({ group: dim.groupTitle, label: dim.label, value });
    }
  }
  return rows;
}

/** Counter/cost rows used when the session reports no dimensions. */
function usageCounterRows(usage: DevinUsage): UsageRow[] {
  const rows: UsageRow[] = [];
  const tokens = (n: number) => `${formatCount(n)} token${n === 1 ? "" : "s"}`;
  if (usage.inputTokens !== undefined)
    rows.push({ label: "Input", value: tokens(usage.inputTokens) });
  if (usage.outputTokens !== undefined)
    rows.push({ label: "Output", value: tokens(usage.outputTokens) });
  if (usage.cachedReadTokens !== undefined)
    rows.push({ label: "Cached read", value: tokens(usage.cachedReadTokens) });
  if (usage.cachedWriteTokens !== undefined)
    rows.push({ label: "Cached write", value: tokens(usage.cachedWriteTokens) });
  if (usage.totalCreditCost !== undefined)
    rows.push({ label: "Credits", value: formatAmount(usage.totalCreditCost) });
  if (usage.totalAcuCost !== undefined)
    rows.push({ label: "ACUs", value: formatAmount(usage.totalAcuCost) });
  if (usage.cost) {
    const symbol = usage.cost.currency === "USD" ? "$" : `${usage.cost.currency} `;
    rows.push({ label: "Cost", value: `${symbol}${formatAmount(usage.cost.amount)}` });
  }
  return rows;
}

/** The tail of a turn: throughput/timing stats and per-call counts. */
function turnTailRows(stats: DevinTurnStats): UsageRow[] {
  const speed: string[] = [];
  if (stats.tokensPerSec !== undefined) speed.push(`${stats.tokensPerSec.toFixed(1)} tok/s`);
  if (stats.ttftMs !== undefined) speed.push(`ttft ${formatMs(stats.ttftMs)}`);
  if (stats.totalTimeMs !== undefined) speed.push(`total ${formatMs(stats.totalTimeMs)}`);
  const calls: string[] = [];
  if (stats.toolCalls !== undefined) calls.push(`${stats.toolCalls} tool calls`);
  if (stats.commandsRun !== undefined) calls.push(`${stats.commandsRun} commands`);
  if (stats.filesChanged !== undefined) calls.push(`${stats.filesChanged} files changed`);
  const rows: UsageRow[] = [];
  if (speed.length) rows.push({ label: "Speed", value: speed.join(" · ") });
  if (calls.length) rows.push({ label: "Calls", value: calls.join(" · ") });
  return rows;
}

/**
 * Multi-line report body for /devin-usage, or undefined when the session has
 * reported nothing yet. Mirrors pi-usage's `  Label:`-padded row style.
 */
export function formatDevinUsageReport(snapshot: DevinStateSnapshot): string | undefined {
  const usage = snapshot.usage;
  const stats = snapshot.lastTurnStats;

  const sections: { header?: string; rows: UsageRow[] }[] = [];

  // Context occupancy — the only percentage-shaped window devin reports.
  const contextRows: UsageRow[] = [];
  if (usage?.contextUsed !== undefined) {
    const size = usage.contextSize;
    const count = size
      ? `${formatCount(usage.contextUsed)} / ${formatCount(size)}`
      : formatCount(usage.contextUsed);
    const value =
      size && size > 0
        ? `${bar((usage.contextUsed / size) * 100)} ${Math.round((usage.contextUsed / size) * 100)}% used · ${count} tokens`
        : `${count} tokens`;
    contextRows.push({ label: "Context", value });
  }

  const sessionDims = dimensionRows(usage?.dimensions);
  if (sessionDims.length) {
    // Server-grouped dimensions carry their own section headers.
    for (const row of sessionDims) sections.push({ header: row.group, rows: [row] });
  } else if (usage) {
    const rows = usageCounterRows(usage);
    if (rows.length) sections.push({ header: "Session", rows });
  }

  if (stats) {
    const rows = [...dimensionRows(stats.dimensions), ...turnTailRows(stats)];
    if (rows.length) sections.push({ header: "Last turn", rows });
  }

  if (contextRows.length === 0 && sections.length === 0) return undefined;

  const model = stats?.modelLabel ?? snapshot.concreteModel ?? snapshot.model;
  const title = snapshot.title ? ` — ${snapshot.title.replace(/\s+/g, " ").trim()}` : "";
  const lines = [`Devin${model ? ` · ${model}` : ""}${title}`];

  const emit = (header: string | undefined, rows: UsageRow[]) => {
    if (lines.length > 1) lines.push("");
    if (header) lines.push(`  ${header}`);
    for (const row of rows) {
      lines.push(`  ${`${row.label}:`.padEnd(LABEL_COLUMN)}${row.value}`);
    }
  };

  emit(undefined, contextRows);

  // Merge consecutive dimension sections that share a group header.
  const merged: { header?: string; rows: UsageRow[] }[] = [];
  for (const section of sections) {
    const last = merged[merged.length - 1];
    if (last && last.header === section.header) last.rows.push(...section.rows);
    else merged.push({ header: section.header, rows: [...section.rows] });
  }
  for (const section of merged) emit(section.header, section.rows);

  return lines.join("\n");
}

export interface DevinUsageUiDeps {
  snapshot: () => Promise<DevinStateSnapshot>;
}

/** Run the /devin-usage flow: a Refresh/Close report like /usage's menu. */
export async function runDevinUsagePicker(
  ctx: ExtensionContext,
  deps: DevinUsageUiDeps,
): Promise<void> {
  let report: string | undefined;
  try {
    report = formatDevinUsageReport(await deps.snapshot());
  } catch (error) {
    ctx.ui.notify(
      `devin: usage unavailable (${error instanceof Error ? error.message : error}).`,
      "error",
    );
    return;
  }
  if (!report) {
    ctx.ui.notify("devin: no usage reported yet — usage appears after the first turn.", "info");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify(report, "info");
    return;
  }
  while (true) {
    const action = await ctx.ui.select(report, [REFRESH, CLOSE]);
    if (!action || action === CLOSE) return;
    try {
      report = formatDevinUsageReport(await deps.snapshot()) ?? report;
    } catch {
      // A failed refresh keeps the last report.
    }
  }
}
