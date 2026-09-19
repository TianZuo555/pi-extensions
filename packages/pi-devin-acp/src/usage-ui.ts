/**
 * /devin-usage — render the usage devin reports over ACP (usage_update
 * counters/cost + agent_stopped response dimensions) in /usage's report
 * style: padded label column, a block bar for context occupancy, grouped
 * sections. ACP has no pull-based usage request, so the report renders the
 * latest pushed snapshot; Refresh re-reads it (useful while a turn runs).
 * The account quota (daily/weekly windows, overage balance) is pulled
 * separately via fetchDevinQuota — the same GetUserStatus RPC devin's own
 * /usage calls — and rendered as the leading Quota section.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DevinQuota, DevinQuotaResult } from "../lib/quota.ts";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** devin's daily reset wording: "in 19h 1m" / "in 1d 4h" / "in 7m". */
export function formatResetIn(resetAtMs: number, now = Date.now()): string {
  const ms = Math.max(0, resetAtMs - now);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "in <1m";
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `in ${minutes}m`;
  const days = Math.floor(hours / 24);
  if (days >= 1) return `in ${days}d ${hours % 24}h`;
  return `in ${hours}h ${minutes % 60}m`;
}

/** devin's weekly reset wording: "Sep 20, 4:00 PM (UTC+8)" in local time. */
export function formatResetAt(resetAtMs: number): string {
  const date = new Date(resetAtMs);
  const h24 = date.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const meridiem = h24 < 12 ? "AM" : "PM";
  const minute = String(date.getMinutes()).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const tz =
    abs % 60 === 0
      ? `UTC${sign}${abs / 60}`
      : `UTC${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${h12}:${minute} ${meridiem} (${tz})`;
}

/**
 * Quota rows mirroring devin's own /usage: daily resets get a relative
 * countdown, weekly an absolute local time; the balance is a flat dollar row.
 */
function quotaRows(quota: DevinQuota, now: number): UsageRow[] {
  const rows: UsageRow[] = [];
  const window = (label: string, usedPercent: number | undefined, reset: string | undefined) => {
    if (usedPercent === undefined) return;
    const value = `${bar(usedPercent)} ${usedPercent}% used${reset ? ` · resets ${reset}` : ""}`;
    rows.push({ label, value });
  };
  window(
    "Daily",
    quota.dailyUsedPercent,
    quota.dailyResetAtMs === undefined ? undefined : formatResetIn(quota.dailyResetAtMs, now),
  );
  window(
    "Weekly",
    quota.weeklyUsedPercent,
    quota.weeklyResetAtMs === undefined ? undefined : formatResetAt(quota.weeklyResetAtMs),
  );
  if (quota.overageBalanceUsd !== undefined) {
    rows.push({ label: "Extra usage balance", value: `$${quota.overageBalanceUsd.toFixed(2)}` });
  }
  return rows;
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
 * Multi-line report body for /devin-usage, or undefined when neither quota
 * nor session has anything to show. Mirrors pi-usage's `  Label:`-padded row
 * style; the leading Quota section matches devin CLI's own /usage wording.
 */
export function formatDevinUsageReport(
  snapshot: DevinStateSnapshot,
  quotaResult?: DevinQuotaResult,
): string | undefined {
  const usage = snapshot.usage;
  const stats = snapshot.lastTurnStats;

  const sections: { header?: string; rows: UsageRow[] }[] = [];
  const headRows: UsageRow[] = [];
  let quotaSectionRows: UsageRow[] = [];

  if (quotaResult) {
    if (quotaResult.ok) {
      quotaSectionRows = quotaRows(quotaResult.quota, Date.now());
    } else {
      headRows.push({ label: "Quota", value: `unavailable — ${quotaResult.reason}` });
    }
  }

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

  if (
    headRows.length === 0 &&
    quotaSectionRows.length === 0 &&
    contextRows.length === 0 &&
    sections.length === 0
  ) {
    return undefined;
  }

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

  emit(undefined, headRows);
  if (quotaSectionRows.length) emit("Quota", quotaSectionRows);
  emit(undefined, contextRows);

  // Merge consecutive dimension sections that share a group header.
  const merged: { header?: string; rows: UsageRow[] }[] = [];
  for (const section of sections) {
    const last = merged[merged.length - 1];
    if (last && last.header === section.header) last.rows.push(...section.rows);
    else merged.push({ header: section.header, rows: [...section.rows] });
  }
  for (const section of merged) emit(section.header, section.rows);

  // devin's /usage closes with the session's own consumption; when nothing
  // was consumed yet its fixed line is the whole tail.
  if (quotaResult?.ok && merged.length === 0) {
    lines.push("", " No quota consumed yet in this session.");
  }

  return lines.join("\n");
}

export interface DevinUsageUiDeps {
  snapshot: () => Promise<DevinStateSnapshot>;
  /**
   * Pull the account quota (GetUserStatus). When omitted the report renders
   * session usage only, like before quota support existed.
   */
  quota?: () => Promise<DevinQuotaResult>;
}

/** Snapshot + quota in one round trip; a quota throw degrades to an error row. */
async function gatherUsageReport(deps: DevinUsageUiDeps): Promise<string | undefined> {
  const quotaPromise = deps.quota
    ? deps.quota().catch(
        (error): DevinQuotaResult => ({
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
    : Promise.resolve(undefined);
  const [snapshot, quota] = await Promise.all([deps.snapshot(), quotaPromise]);
  return formatDevinUsageReport(snapshot, quota);
}

/** Run the /devin-usage flow: a Refresh/Close report like /usage's menu. */
export async function runDevinUsagePicker(
  ctx: ExtensionContext,
  deps: DevinUsageUiDeps,
): Promise<void> {
  let report: string | undefined;
  try {
    report = await gatherUsageReport(deps);
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
      report = (await gatherUsageReport(deps)) ?? report;
    } catch {
      // A failed refresh keeps the last report.
    }
  }
}
