// Width-safe terminal bar charts for the /tokens panel.
//
// All output lines are built for a target width and truncated with
// truncateToWidth so every render stays within the component contract
// (visible width <= requested width), including narrow terminals.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface ChartBucket {
  /** Short label under the bucket (e.g. "12" for a day, "14" for an hour). */
  readonly label: string;
  readonly value: number;
  /**
   * True when the bucket has any recorded activity in some metric (tokens,
   * cost, or requests). A bucket that is zero in the *current* metric but
   * active renders a tiny dim bar instead of the empty dot — e.g. a day of
   * zero-cost provider usage while the chart shows cost.
   */
  readonly active?: boolean;
}

export interface ChartTheme {
  /** Color the bar body (default: none/plain). */
  bar?: (text: string) => string;
  /** Color the peak bar (default: bar). */
  peakBar?: (text: string) => string;
  /** Color tick labels (default: none/plain). */
  label?: (text: string) => string;
}

export interface BarChartOptions {
  readonly buckets: readonly ChartBucket[];
  readonly width: number;
  /** Bar rows (default 6). */
  readonly rows?: number;
  readonly theme?: ChartTheme;
  /** True when the newest (right-most) bucket is "today/now". */
  readonly highlightLast?: boolean;
}

const BLOCK = "█";
const TINY = "▁";

/**
 * Vertical bar chart: one column per bucket, labels below, peak annotated.
 * When buckets exceed the available width the oldest are dropped so the most
 * recent data stays visible.
 */
export function buildBarChart(options: BarChartOptions): string[] {
  const width = Math.max(8, options.width);
  const rows = Math.max(1, Math.min(12, options.rows ?? 6));
  const theme = options.theme ?? {};

  let buckets = options.buckets;
  const slot = buckets.length > 16 ? 2 : 3; // bar width + gap
  const capacity = Math.floor(width / slot);
  if (buckets.length > capacity) buckets = buckets.slice(buckets.length - capacity);

  const max = Math.max(1, ...buckets.map((bucket) => bucket.value));
  const peakIndex = buckets.findIndex((bucket) => bucket.value === max);
  // Sqrt scale: a dominant peak otherwise flattens every other bar to 1-2
  // rows on a linear scale (e.g. 307M peak vs 14M day). Sqrt keeps the peak
  // tallest while mid-size days stay readable; ordering is preserved.
  // A bucket whose scaled height rounds below one row keeps a tiny ▁ stub on
  // the bottom row instead of a full block, so small days stay distinguishable
  // from both busy days and truly empty ones (which render as blank space).
  const heights = buckets.map((bucket) =>
    bucket.value > 0 ? Math.round(Math.sqrt(bucket.value / max) * rows) : 0,
  );

  const lines: string[] = [];
  for (let row = rows; row >= 1; row--) {
    let line = "";
    for (let index = 0; index < buckets.length; index++) {
      const barWidth = slot - 1;
      const bucket = buckets[index]!;
      const gapWidth = index < buckets.length - 1 ? slot - barWidth : 0;
      const isPeak = index === peakIndex && buckets.length > 1;
      const paint = isPeak ? (theme.peakBar ?? theme.bar) : theme.bar;
      if (heights[index]! >= row) {
        const block = BLOCK.repeat(barWidth);
        line += paint ? paint(block) : block;
        line += " ".repeat(gapWidth);
      } else if (row === 1 && bucket.value > 0) {
        // Positive but below one row on the scale: a tiny stub at the bottom.
        const stub = TINY.repeat(barWidth);
        line += paint ? paint(stub) : stub;
        line += " ".repeat(gapWidth);
      } else if (row === 1 && bucket.active) {
        // Zero in this metric but usage exists elsewhere (other metric or
        // requests): a tiny dim stub.
        line += theme.label ? theme.label(TINY.repeat(barWidth)) : TINY.repeat(barWidth);
        line += " ".repeat(gapWidth);
      } else {
        // Empty bucket: blank space, so zero usage draws nothing at all.
        line += " ".repeat(barWidth + gapWidth);
      }
    }
    lines.push(line);
  }

  // Sparse tick labels: at most ~6, anchored under their buckets. Composed as
  // whole segments so ANSI-colored labels stay intact.
  const ticks = pickTicks(buckets, width, slot);
  lines.push(buildLabelLine(buckets, ticks, slot, theme.label));

  return lines.map((line) => truncateToWidth(line.replace(/\s+$/, ""), width, ""));
}

/** Peak annotation line, e.g. "peak 4.2M on Aug 14". */
export function buildPeakLine(
  buckets: readonly { label: string; value: number }[],
  formatValue: (value: number) => string,
): string | undefined {
  let peak = buckets[0];
  for (const bucket of buckets) {
    if (bucket.value > (peak?.value ?? 0)) peak = bucket;
  }
  if (!peak || peak.value <= 0) return undefined;
  return `peak ${formatValue(peak.value)} on ${peak.label}`;
}

function pickTicks(buckets: readonly ChartBucket[], width: number, slot: number): number[] {
  const capacity = Math.floor(width / slot);
  const count = buckets.length;
  if (count === 0 || capacity === 0) return [];
  const maxTicks = Math.max(1, Math.min(6, Math.floor(width / 8)));
  if (count <= maxTicks) return buckets.map((_bucket, index) => index);
  // Anchor the stride to the newest bucket so "today"/the current hour is
  // always labeled, then walk backwards at an even stride.
  const stride = Math.ceil(count / maxTicks);
  const ticks: number[] = [];
  for (let index = count - 1; index >= 0; index -= stride) ticks.push(index);
  return ticks.reverse();
}

function columnOf(index: number, slot: number): number {
  return index * slot;
}

function buildLabelLine(
  buckets: readonly ChartBucket[],
  ticks: readonly number[],
  slot: number,
  paint: ((text: string) => string) | undefined,
): string {
  let line = "";
  let cursor = 0;
  for (const index of ticks) {
    const bucket = buckets[index];
    if (!bucket) continue;
    const column = columnOf(index, slot);
    if (column < cursor) continue;
    line += " ".repeat(column - cursor);
    const text = paint ? paint(bucket.label) : bucket.label;
    line += text;
    // visibleWidth, not text.length: painted labels carry ANSI bytes that
    // would otherwise inflate the cursor and drop later ticks.
    cursor = column + visibleWidth(text);
  }
  return line;
}
