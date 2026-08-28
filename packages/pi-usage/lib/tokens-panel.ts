// Interactive /tokens panel: a self-contained TUI component that renders the
// local token/cost history for one window (1d / 7d / 30d / MTD) with a bar
// chart, and navigates via keyboard. Implements Component directly (like
// pi-ask-user's form) so render(width) can truncate every line to width.

import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ScanResult } from "../src/local-scan.ts";
import { buildBarChart, buildPeakLine } from "./tokens-chart.ts";
import {
  aggregateWindow,
  buildDayIndex,
  buildHourBuckets,
  formatCostCompact,
  formatMetricCompact,
  formatTokensCompact,
  formatTokensFull,
  localDateKey,
  topModels,
  windowRange,
  WINDOW_LABELS,
  WINDOW_ORDER,
  type DayUsage,
  type Metric,
  type WindowKey,
} from "./tokens-model.ts";

export interface PanelTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

export interface PanelKeybindings {
  matches(data: string, keybinding: string): boolean;
}

export interface TokensPanelArgs {
  readonly tui: { requestRender(): void };
  readonly theme: PanelTheme;
  readonly keybindings: PanelKeybindings;
  readonly snapshot: ScanResult;
  readonly refresh: () => Promise<ScanResult | undefined>;
  readonly done: () => void;
}

interface DayBucket {
  readonly short: string;
  readonly full: string;
  readonly tokens: number;
  readonly cost: number;
  readonly requests: number;
}

const DEFAULT_WINDOW: WindowKey = "7d";
const MODEL_ROWS = 3;

export class TokensPanel {
  private readonly tui: { requestRender(): void };
  private readonly theme: PanelTheme;
  private readonly keybindings: PanelKeybindings;
  private readonly refreshScan: () => Promise<ScanResult | undefined>;
  private readonly doneCallback: () => void;

  private snapshot: ScanResult;
  private dayIndex: Map<string, DayUsage>;
  private now: Date;
  private windowIndex = Math.max(0, WINDOW_ORDER.indexOf(DEFAULT_WINDOW));
  private metric: Metric = "tokens";
  private refreshing = false;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(args: TokensPanelArgs) {
    this.tui = args.tui;
    this.theme = args.theme;
    this.keybindings = args.keybindings;
    this.refreshScan = args.refresh;
    this.doneCallback = args.done;
    this.snapshot = args.snapshot;
    this.now = new Date();
    this.dayIndex = buildDayIndex(args.snapshot.records);
  }

  handleInput(data: string): boolean {
    if (this.keybindings.matches(data, "cancel") || matchesKey(data, Key.escape) || data === "q") {
      this.done();
      return true;
    }
    // matchesKey understands legacy CSI sequences, application cursor mode,
    // and the Kitty keyboard protocol — raw "\x1b[D" comparisons do not.
    if (matchesKey(data, Key.left) || data === "h") {
      this.windowIndex = (this.windowIndex - 1 + WINDOW_ORDER.length) % WINDOW_ORDER.length;
      this.redraw();
      return true;
    }
    if (matchesKey(data, Key.right) || data === "l") {
      this.windowIndex = (this.windowIndex + 1) % WINDOW_ORDER.length;
      this.redraw();
      return true;
    }
    const digit = Number(data);
    if (digit >= 1 && digit <= WINDOW_ORDER.length) {
      this.windowIndex = digit - 1;
      this.redraw();
      return true;
    }
    if (matchesKey(data, Key.tab)) {
      this.metric = this.metric === "tokens" ? "cost" : "tokens";
      this.redraw();
      return true;
    }
    if (data === "r" || data === "R") {
      void this.rescan();
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      this.done();
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    if (this.cachedLines && this.cachedWidth === renderWidth) return this.cachedLines;

    const t = this.theme;
    const lines: string[] = [t.fg("accent", "─".repeat(renderWidth))];

    const title = this.refreshing
      ? "tokens · local pi usage · rescanning…"
      : "tokens · local pi usage";
    lines.push(clip(` ${t.bold(t.fg("accent", title))}`, renderWidth));
    lines.push(
      clip(
        ` ${t.fg("muted", `${this.snapshot.filesScanned} session files · dedup by message id`)}`,
        renderWidth,
      ),
    );
    lines.push("");
    lines.push(clip(` ${this.windowTabs()}`, renderWidth));
    lines.push(
      clip(
        ` ${t.fg("muted", "←/→ or h/l window · 1-4 jump · Tab tokens/cost · r rescan · Esc close")}`,
        renderWidth,
      ),
    );
    lines.push(t.fg("accent", "─".repeat(renderWidth)));

    const window = WINDOW_ORDER[this.windowIndex] ?? DEFAULT_WINDOW;
    const aggregate = aggregateWindow(window, this.now, this.dayIndex);

    lines.push(
      clip(
        ` ${t.fg("muted", `${WINDOW_LABELS[window]} (${this.windowDateLabel(window)}) · per ${window === "1d" ? "hour" : "day"}, ${this.metric}`)}`,
        renderWidth,
      ),
    );
    lines.push(
      clip(
        ` ${t.bold(`${formatTokensCompact(aggregate.totalTokens)} tokens`)} ${t.fg("muted", "·")} ${t.bold(formatCostCompact(aggregate.costUSD))}`,
        renderWidth,
      ),
    );
    lines.push(
      clip(
        ` ${t.fg(
          "muted",
          `${formatTokensFull(aggregate.requests)} requests · in ${formatTokensCompact(aggregate.inputTokens)} · out ${formatTokensCompact(aggregate.outputTokens)} · cache ${formatTokensCompact(aggregate.cacheReadTokens + aggregate.cacheWriteTokens)}`,
        )}`,
        renderWidth,
      ),
    );
    lines.push(
      clip(
        ` ${t.fg("muted", "cost at list prices (subscription plans may cover it)")}`,
        renderWidth,
      ),
    );
    lines.push("");

    const buckets = this.chartBuckets(window);
    const chartLines = buildBarChart({
      buckets: buckets.map((bucket) => ({
        label: bucket.short,
        value: this.bucketValue(bucket),
        // Any activity counts, not just the displayed metric — a zero-cost
        // provider's day must not look empty in the cost view.
        active: bucket.tokens > 0 || bucket.cost > 0 || bucket.requests > 0,
      })),
      width: Math.max(8, renderWidth - 2),
      rows: 6,
      theme: {
        bar: (text) => t.fg("accent", text),
        peakBar: (text) => t.bold(t.fg("accent", text)),
        label: (text) => t.fg("muted", text),
      },
    });
    const peak = buildPeakLine(
      buckets.map((bucket) => ({ label: bucket.full, value: this.bucketValue(bucket) })),
      (value) => formatMetricCompact(value, this.metric),
    );
    if (peak) lines.push(clip(` ${t.fg("muted", peak)}`, renderWidth));
    for (const line of chartLines) lines.push(clip(` ${line}`, renderWidth));
    lines.push("");

    const models = topModels(aggregate.models, this.metric, MODEL_ROWS);
    if (models.length > 0) {
      lines.push(clip(` ${t.fg("muted", `top models by ${this.metric}`)}`, renderWidth));
      for (const [model, usage] of models) {
        const row = `${model}  ${formatTokensCompact(usage.totalTokens)}  ${formatCostCompact(usage.costUSD)}`;
        lines.push(clip(`   ${row}`, renderWidth));
      }
    }

    lines.push(t.fg("accent", "─".repeat(renderWidth)));
    this.cachedWidth = renderWidth;
    this.cachedLines = lines;
    return lines;
  }

  dispose(): void {
    this.cachedLines = undefined;
  }

  private done(): void {
    this.doneCallback();
  }

  /** Component contract: drop the render cache (no re-render requested). */
  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private redraw(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private async rescan(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.redraw();
    try {
      const next = await this.refreshScan();
      if (next) {
        this.snapshot = next;
        this.now = new Date();
        this.dayIndex = buildDayIndex(next.records);
      }
    } finally {
      this.refreshing = false;
      this.redraw();
    }
  }

  private bucketValue(bucket: DayBucket): number {
    return this.metric === "cost" ? bucket.cost : bucket.tokens;
  }

  private windowTabs(): string {
    const t = this.theme;
    return WINDOW_ORDER.map((key, index) => {
      const label = key === "mtd" ? "MTD" : key;
      const text =
        index === this.windowIndex ? t.bold(t.fg("accent", `[${label}]`)) : t.fg("muted", label);
      return index === 0 ? text : ` ${text}`;
    }).join("");
  }

  private windowDateLabel(window: WindowKey): string {
    const start = new Date(aggregateStart(window, this.now));
    const end = this.now;
    if (window === "1d") return this.formatDay(end);
    if (window === "mtd") {
      return `${start.toLocaleDateString("en-US", { month: "short" })} 1 – ${end.getDate()}`;
    }
    return `${this.formatDay(start)} – ${this.formatDay(end)}`;
  }

  private formatDay(date: Date): string {
    return `${date.toLocaleDateString("en-US", { month: "short" })} ${date.getDate()}`;
  }

  private chartBuckets(window: WindowKey): DayBucket[] {
    if (window === "1d") {
      const todayKey = localDateKey(this.now);
      // Only hours up to "now" — future hours would render as all-zero columns
      // and push the anchored tick label away from the current hour.
      return buildHourBuckets(todayKey, this.snapshot.records)
        .slice(0, this.now.getHours() + 1)
        .map((hour) => ({
          short: `${hour.hour}`,
          full: `${`${hour.hour}`.padStart(2, "0")}:00`,
          tokens: hour.totalTokens,
          cost: hour.costUSD,
          requests: hour.requests,
        }));
    }
    return aggregateWindow(window, this.now, this.dayIndex).days.map((day) => ({
      short: `${day.date.getDate()}`,
      full: this.formatDay(day.date),
      tokens: day.totalTokens,
      cost: day.costUSD,
      requests: day.requests,
    }));
  }
}

function aggregateStart(window: WindowKey, now: Date): number {
  return windowRange(window, now).startMs;
}

function clip(line: string, width: number): string {
  return truncateToWidth(line, width, "");
}
