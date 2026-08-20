// Pure logic for the /tokens view: window definitions (1d / 7d / 30d / MTD),
// bucketing of scanned usage records into days or hours, and compact number
// formatting. No I/O and no TUI here so everything is unit-testable.

export type WindowKey = "1d" | "7d" | "30d" | "mtd";
export type Metric = "tokens" | "cost";

export const WINDOW_ORDER: readonly WindowKey[] = ["1d", "7d", "30d", "mtd"];

export const WINDOW_LABELS: Record<WindowKey, string> = {
  "1d": "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  mtd: "Month to date",
};

/** One aggregated usage record source: a single assistant message with usage. */
export interface UsageRecord {
  readonly id: string;
  readonly ts: number;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costUSD: number;
}

export interface ModelUsage {
  totalTokens: number;
  costUSD: number;
  requests: number;
}

export interface DayUsage {
  readonly dateKey: string; // YYYY-MM-DD (local)
  readonly date: Date; // local midnight
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUSD: number;
  requests: number;
  models: Map<string, ModelUsage>; // key: "provider/model"
}

export interface HourUsage {
  readonly hour: number; // 0-23 local
  totalTokens: number;
  costUSD: number;
  requests: number;
}

/** Aggregate of one usage window, ready for display. */
export interface WindowAggregate {
  readonly key: WindowKey;
  readonly startMs: number;
  readonly endMs: number;
  readonly days: DayUsage[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costUSD: number;
  readonly requests: number;
  readonly models: Map<string, ModelUsage>;
}

export interface WindowRange {
  readonly key: WindowKey;
  readonly startMs: number;
  readonly endMs: number;
}

export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Inclusive day range: today for 1d, rolling whole days for 7d/30d, month for MTD. */
export function windowRange(key: WindowKey, now: Date): WindowRange {
  const today = startOfLocalDay(now);
  switch (key) {
    case "1d":
      return { key, startMs: today.getTime(), endMs: now.getTime() };
    case "7d": {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      return { key, startMs: start.getTime(), endMs: now.getTime() };
    }
    case "30d": {
      const start = new Date(today);
      start.setDate(start.getDate() - 29);
      return { key, startMs: start.getTime(), endMs: now.getTime() };
    }
    case "mtd":
      return {
        key,
        startMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
        endMs: now.getTime(),
      };
  }
}

/** Day buckets for a window, oldest first, including empty days. */
export function windowDayKeys(range: WindowRange, now: Date): string[] {
  const start = startOfLocalDay(new Date(range.startMs));
  const end = startOfLocalDay(new Date(range.endMs));
  const keys: string[] = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    keys.push(localDateKey(cursor));
  }
  // Guard against a broken clock (end before start) producing nothing.
  if (keys.length === 0) keys.push(localDateKey(now));
  return keys;
}

export function aggregateWindow(
  key: WindowKey,
  now: Date,
  dayIndex: ReadonlyMap<string, DayUsage>,
): WindowAggregate {
  const range = windowRange(key, now);
  // Keep every day in the window (empty ones included) so the day chart stays
  // continuous; totals are unaffected because empty days contribute zero.
  const days = windowDayKeys(range, now).map((dateKey) => dayIndex.get(dateKey) ?? emptyDay(dateKey, now));

  const totals = {
    key,
    startMs: range.startMs,
    endMs: range.endMs,
    days,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    requests: 0,
    models: new Map<string, ModelUsage>(),
  };

  for (const day of days) {
    totals.inputTokens += day.inputTokens;
    totals.outputTokens += day.outputTokens;
    totals.cacheReadTokens += day.cacheReadTokens;
    totals.cacheWriteTokens += day.cacheWriteTokens;
    totals.totalTokens += day.totalTokens;
    totals.costUSD += day.costUSD;
    totals.requests += day.requests;
    for (const [model, usage] of day.models) {
      const current = totals.models.get(model) ?? { totalTokens: 0, costUSD: 0, requests: 0 };
      current.totalTokens += usage.totalTokens;
      current.costUSD += usage.costUSD;
      current.requests += usage.requests;
      totals.models.set(model, current);
    }
  }
  return totals;
}

function emptyDay(dateKey: string, reference: Date): DayUsage {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(
    year ?? reference.getFullYear(),
    (month ?? reference.getMonth() + 1) - 1,
    day ?? reference.getDate(),
  );
  return {
    dateKey,
    date,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    requests: 0,
    models: new Map(),
  };
}

/** Aggregate records into a per-day index (local days) keyed by YYYY-MM-DD. */
export function buildDayIndex(records: readonly UsageRecord[]): Map<string, DayUsage> {
  const index = new Map<string, DayUsage>();
  for (const record of records) {
    const date = new Date(record.ts);
    if (Number.isNaN(date.getTime())) continue;
    const dateKey = localDateKey(date);
    let day = index.get(dateKey);
    if (!day) {
      day = emptyDay(dateKey, date);
      index.set(dateKey, day);
    }
    day.inputTokens += record.inputTokens;
    day.outputTokens += record.outputTokens;
    day.cacheReadTokens += record.cacheReadTokens;
    day.cacheWriteTokens += record.cacheWriteTokens;
    day.totalTokens += record.totalTokens;
    day.costUSD += record.costUSD;
    day.requests += 1;
    const modelKey = `${record.provider}/${record.model}`;
    const model = day.models.get(modelKey) ?? { totalTokens: 0, costUSD: 0, requests: 0 };
    model.totalTokens += record.totalTokens;
    model.costUSD += record.costUSD;
    model.requests += 1;
    day.models.set(modelKey, model);
  }
  return index;
}

/** 24 local-hour buckets for one dateKey (the 1d window chart). */
export function buildHourBuckets(
  dateKey: string,
  records: readonly UsageRecord[],
): HourUsage[] {
  const buckets: HourUsage[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    totalTokens: 0,
    costUSD: 0,
    requests: 0,
  }));
  for (const record of records) {
    const date = new Date(record.ts);
    if (Number.isNaN(date.getTime()) || localDateKey(date) !== dateKey) continue;
    const bucket = buckets[date.getHours()];
    if (!bucket) continue;
    bucket.totalTokens += record.totalTokens;
    bucket.costUSD += record.costUSD;
    bucket.requests += 1;
  }
  return buckets;
}

/** Sort models by the given metric, descending. */
export function topModels(
  models: ReadonlyMap<string, ModelUsage>,
  metric: Metric,
  limit: number,
): Array<[string, ModelUsage]> {
  return [...models.entries()]
    .sort((a, b) => (metric === "cost" ? b[1].costUSD - a[1].costUSD : b[1].totalTokens - a[1].totalTokens))
    .slice(0, limit);
}

// --- formatting --------------------------------------------------------------

/** 1,234,567 → "1.2M"; 920 → "920"; 12,400 → "12.4K". */
export function formatTokensCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  const units: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [scale, suffix] of units) {
    if (abs >= scale) {
      const scaled = value / scale;
      const digits = abs >= scale * 100 ? 0 : 1;
      return `${trimZero(scaled.toFixed(digits))}${suffix}`;
    }
  }
  return String(value);
}

/** Full token count with thousands separators. */
export function formatTokensFull(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** 0.002 → "<$0.01"; 39.823 → "$39.82"; 1234.5 → "$1.2K". */
export function formatCostCompact(value: number): string {
  if (value <= 0) return "$0";
  if (value < 0.005) return "<$0.01";
  if (value < 1000) return `$${value.toFixed(2)}`;
  if (value < 1e6) return `$${trimZero((value / 1e3).toFixed(value < 1e4 ? 1 : 0))}K`;
  return `$${trimZero((value / 1e6).toFixed(1))}M`;
}

/** Chart axis value label: compact for both metrics. */
export function formatMetricCompact(value: number, metric: Metric): string {
  return metric === "cost" ? formatCostCompact(value) : formatTokensCompact(value);
}

function trimZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}
