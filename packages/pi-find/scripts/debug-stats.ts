/**
 * Summarize the opt-in pi-find debug log (see lib/debug.ts).
 *
 *   node scripts/debug-stats.ts [--json] [log.jsonl ...]
 *
 * Defaults to the active log and its rotated `.1` sibling. When an event
 * carries a sessionFile, the pi session is read to classify the model's next
 * action after the search: another grep/find (retry), a shell search
 * (fallback), a read, something else, or nothing. The session tree is read in
 * file order, so an abandoned branch can occasionally be counted as "next".
 */

import { existsSync, readFileSync } from "node:fs";
import { DEBUG_EVENT_VERSION, debugFile, type SearchDebugEvent } from "../lib/debug.ts";

export type NextAction = "retry" | "shell_search" | "read" | "other" | "none" | "unknown";

interface ToolCallRecord {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** Tool calls grouped by assistant message, in session file order. */
export type SessionTurns = readonly (readonly ToolCallRecord[])[];

const SHELL_SEARCH = /(^|[\s|;&(`])(rg|grep|egrep|fgrep|find|fd|fdfind|ag|ack|git\s+grep)\s/;

export function parseSessionTurns(jsonl: string): SessionTurns {
  const turns: ToolCallRecord[][] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = (entry as { type?: string; message?: { role?: string; content?: unknown } })
      .message;
    if ((entry as { type?: string }).type !== "message" || message?.role !== "assistant") continue;
    if (!Array.isArray(message.content)) continue;
    const calls = message.content.filter(
      (block): block is ToolCallRecord & { type: "toolCall" } =>
        typeof block === "object" && block !== null && block.type === "toolCall",
    );
    if (calls.length > 0) turns.push(calls);
  }
  return turns;
}

/** The first tool call of the next assistant turn; sibling calls ran in parallel and are not reactions. */
export function nextAction(turns: SessionTurns | undefined, toolCallId: string): NextAction {
  if (turns === undefined) return "unknown";
  const index = turns.findIndex((calls) => calls.some((call) => call.id === toolCallId));
  if (index === -1) return "unknown";
  const next = turns[index + 1]?.[0];
  if (next === undefined) return "none";
  if (next.name === "grep" || next.name === "find") return "retry";
  if (next.name === "read") return "read";
  const command = next.arguments?.command;
  if (next.name === "bash" && typeof command === "string" && SHELL_SEARCH.test(` ${command}`))
    return "shell_search";
  return "other";
}

type Counts = Record<string, number>;

interface Spread {
  p50: number;
  p95: number;
  max: number;
}

/** ADR open question A: do slash globs with a fixed directory prefix pay for scanning the whole tree? */
export interface NarrowableScans {
  /** Searches whose glob has a fixed directory prefix that could become the search path. */
  calls: number;
  timeouts: number;
  durationMs: Spread;
  /** Same measure for every other completed search, as the baseline. */
  otherDurationMs: Spread;
  rejectedByGlob: Spread;
  /** rg's searched-file totals (grep content searches that ran to completion only). */
  searchedFiles: Spread;
  otherSearchedFiles: Spread;
  /** Empty results whose glob starts inside a hidden directory the default walk skips. */
  hiddenPrefixEmpty: number;
  examples: unknown[];
}

/** ADR open question B: what does one call cost in context, and does a big result get used? */
export interface OutputCost {
  bytes: Spread;
  /** Calls returning at least LARGE_OUTPUT_BYTES. */
  large: number;
  outputLimitHit: number;
  /** Calls with at least one clipped match line (grep). */
  withClippedLines: number;
  nextAfterLarge: Counts;
}

export interface ToolSummary {
  calls: number;
  outcomes: Counts;
  durationMs: { p50: number; p95: number };
  emptyComplete: number;
  partial: number;
  partialReasons: Counts;
  emptyWithGlobRejections: number;
  broadScans: number;
  droppedContext: number;
  notices: Counts;
  errorTags: Counts;
  nextAfterEmpty: Counts;
  nextAfterPartial: Counts;
  nextAfterError: Counts;
  narrowable: NarrowableScans;
  output: OutputCost;
  examples: { emptyWithGlobRejections: unknown[]; emptyThenShell: unknown[] };
}

export interface Summary {
  events: number;
  ignored: number;
  from?: string;
  to?: string;
  tools: Record<string, ToolSummary>;
}

const MAX_EXAMPLES = 5;
/** About 4k tokens: a single call at this size is a noticeable share of a turn's context. */
export const LARGE_OUTPUT_BYTES = 16 * 1024;

/**
 * The fixed directory part of a slash glob (`packages/web/**` → `packages/web`),
 * i.e. what could be handed to rg/fd as the search path instead of the root.
 * Negated globs exclude rather than select, so they have none.
 */
export function staticGlobPrefix(glob: string | undefined): string | undefined {
  if (glob === undefined || glob.startsWith("!") || !glob.includes("/")) return undefined;
  const fixed: string[] = [];
  for (const segment of glob
    .replace(/^(\.\/)+/, "")
    .split("/")
    .slice(0, -1)) {
    if (segment.length === 0 || /[*?[\]{}()!+@]/.test(segment)) break;
    fixed.push(segment);
  }
  return fixed.length > 0 ? fixed.join("/") : undefined;
}

function bump(counts: Counts, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) ?? 0 };
}

function emptySpread(): Spread {
  return { p50: 0, p95: 0, max: 0 };
}

function emptySummary(): ToolSummary {
  return {
    calls: 0,
    outcomes: {},
    durationMs: { p50: 0, p95: 0 },
    emptyComplete: 0,
    partial: 0,
    partialReasons: {},
    emptyWithGlobRejections: 0,
    broadScans: 0,
    droppedContext: 0,
    notices: {},
    errorTags: {},
    nextAfterEmpty: {},
    nextAfterPartial: {},
    nextAfterError: {},
    narrowable: {
      calls: 0,
      timeouts: 0,
      durationMs: emptySpread(),
      otherDurationMs: emptySpread(),
      rejectedByGlob: emptySpread(),
      searchedFiles: emptySpread(),
      otherSearchedFiles: emptySpread(),
      hiddenPrefixEmpty: 0,
      examples: [],
    },
    output: {
      bytes: emptySpread(),
      large: 0,
      outputLimitHit: 0,
      withClippedLines: 0,
      nextAfterLarge: {},
    },
    examples: { emptyWithGlobRejections: [], emptyThenShell: [] },
  };
}

interface Samples {
  durations: number[];
  narrowDurations: number[];
  otherDurations: number[];
  narrowRejected: number[];
  narrowSearched: number[];
  otherSearched: number[];
  outputBytes: number[];
}

function globOf(event: SearchDebugEvent): string | undefined {
  const value = event.tool === "grep" ? event.params.glob : event.params.pattern;
  return typeof value === "string" ? value : undefined;
}

export function summarize(
  events: readonly SearchDebugEvent[],
  loadTurns: (sessionFile: string) => SessionTurns | undefined,
): Summary {
  const current = events.filter((event) => event.v === DEBUG_EVENT_VERSION);
  const summary: Summary = {
    events: current.length,
    ignored: events.length - current.length,
    from: current[0]?.ts,
    to: current.at(-1)?.ts,
    tools: {},
  };
  const samples = new Map<string, Samples>();
  for (const event of current) {
    const tool = summary.tools[event.tool] ?? emptySummary();
    summary.tools[event.tool] = tool;
    const sample = samples.get(event.tool) ?? {
      durations: [],
      narrowDurations: [],
      otherDurations: [],
      narrowRejected: [],
      narrowSearched: [],
      otherSearched: [],
      outputBytes: [],
    };
    samples.set(event.tool, sample);
    tool.calls += 1;
    bump(tool.outcomes, event.outcome);
    sample.durations.push(event.durationMs);
    const next = nextAction(
      event.sessionFile === undefined ? undefined : loadTurns(event.sessionFile),
      event.toolCallId,
    );

    if (event.outcome === "error") {
      bump(tool.errorTags, event.errorTag ?? "unknown");
      bump(tool.nextAfterError, next);
    }
    if (event.outcome !== "ok") continue;
    for (const id of event.notices ?? []) bump(tool.notices, id);
    if (event.prefilter === "*") tool.broadScans += 1;
    if (event.droppedContext) tool.droppedContext += 1;

    const glob = globOf(event);
    const prefix = staticGlobPrefix(glob);
    if (prefix !== undefined) {
      const scan = tool.narrowable;
      scan.calls += 1;
      if (event.timedOut) scan.timeouts += 1;
      sample.narrowDurations.push(event.durationMs);
      sample.narrowRejected.push(event.rejectedByGlob ?? 0);
      if (event.searchedFiles !== undefined) sample.narrowSearched.push(event.searchedFiles);
      if (scan.examples.length < MAX_EXAMPLES)
        scan.examples.push({
          params: event.params,
          durationMs: event.durationMs,
          rejectedByGlob: event.rejectedByGlob,
          searchedFiles: event.searchedFiles,
        });
      const hiddenPath =
        typeof event.params.path === "string" &&
        event.params.path
          .replace(/^@/, "")
          .split(/[\\/]/)
          .some((part) => /^\.[^./]/.test(part));
      if (
        event.resultCount === 0 &&
        !hiddenPath &&
        prefix.split("/").some((part) => /^\.[^./]/.test(part))
      )
        scan.hiddenPrefixEmpty += 1;
    } else {
      sample.otherDurations.push(event.durationMs);
      if (event.searchedFiles !== undefined) sample.otherSearched.push(event.searchedFiles);
    }

    if (event.outputBytes !== undefined) {
      sample.outputBytes.push(event.outputBytes);
      if (event.outputBytes >= LARGE_OUTPUT_BYTES) {
        tool.output.large += 1;
        bump(tool.output.nextAfterLarge, next);
      }
    }
    if (event.outputLimitHit) tool.output.outputLimitHit += 1;
    if ((event.clippedLines ?? 0) > 0) tool.output.withClippedLines += 1;

    const reasons = [
      ...(event.resultLimitHit ? ["result_limit"] : []),
      ...(event.outputLimitHit ? ["output_limit"] : []),
      ...(event.timedOut ? ["timeout"] : []),
      ...((event.skippedRecords ?? 0) > 0 ? ["skipped_records"] : []),
      ...(event.pathError !== undefined ? ["unreadable_path"] : []),
    ];
    if (reasons.length > 0) {
      tool.partial += 1;
      for (const reason of reasons) bump(tool.partialReasons, reason);
      bump(tool.nextAfterPartial, next);
    } else if (event.resultCount === 0) {
      tool.emptyComplete += 1;
      bump(tool.nextAfterEmpty, next);
      if ((event.rejectedByGlob ?? 0) > 0) {
        tool.emptyWithGlobRejections += 1;
        if (tool.examples.emptyWithGlobRejections.length < MAX_EXAMPLES)
          tool.examples.emptyWithGlobRejections.push({
            params: event.params,
            rejectedByGlob: event.rejectedByGlob,
          });
      }
      if (next === "shell_search" && tool.examples.emptyThenShell.length < MAX_EXAMPLES)
        tool.examples.emptyThenShell.push(event.params);
    }
  }
  for (const [name, tool] of Object.entries(summary.tools)) {
    const sample = samples.get(name);
    if (sample === undefined) continue;
    const all = spread(sample.durations);
    tool.durationMs = { p50: all.p50, p95: all.p95 };
    tool.narrowable.durationMs = spread(sample.narrowDurations);
    tool.narrowable.otherDurationMs = spread(sample.otherDurations);
    tool.narrowable.rejectedByGlob = spread(sample.narrowRejected);
    tool.narrowable.searchedFiles = spread(sample.narrowSearched);
    tool.narrowable.otherSearchedFiles = spread(sample.otherSearched);
    tool.output.bytes = spread(sample.outputBytes);
  }
  return summary;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

function counts(values: Counts): string {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? "-" : entries.map(([key, value]) => `${key} ${value}`).join(", ");
}

function spreadText(value: Spread, unit = ""): string {
  return `p50 ${value.p50}${unit}, p95 ${value.p95}${unit}, max ${value.max}${unit}`;
}

export function formatSummary(summary: Summary): string {
  const lines = [
    `pi-find debug stats: ${summary.events} events${
      summary.from ? ` (${summary.from} → ${summary.to})` : ""
    }${summary.ignored > 0 ? `, ${summary.ignored} from other log versions ignored` : ""}`,
  ];
  for (const [name, tool] of Object.entries(summary.tools)) {
    const ok = tool.outcomes.ok ?? 0;
    const scan = tool.narrowable;
    const output = tool.output;
    lines.push(
      "",
      `${name}: ${tool.calls} calls (${counts(tool.outcomes)}), p50 ${tool.durationMs.p50}ms, p95 ${tool.durationMs.p95}ms`,
      `  empty (complete)        ${tool.emptyComplete} (${pct(tool.emptyComplete, ok)})`,
      `    with glob rejections  ${tool.emptyWithGlobRejections}`,
      `  partial                 ${tool.partial} (${pct(tool.partial, ok)}): ${counts(tool.partialReasons)}`,
      `  broad scans (prefilter *) ${tool.broadScans}`,
      ...(name === "grep" ? [`  context dropped by budget ${tool.droppedContext}`] : []),
      `  notices                 ${counts(tool.notices)}`,
      `  errors                  ${counts(tool.errorTags)}`,
      `  next after empty        ${counts(tool.nextAfterEmpty)}`,
      `  next after partial      ${counts(tool.nextAfterPartial)}`,
      `  next after error        ${counts(tool.nextAfterError)}`,
      `  [A] globs with a fixed dir prefix: ${scan.calls} (${pct(scan.calls, ok)}), timeouts ${scan.timeouts}`,
      `      duration            ${spreadText(scan.durationMs, "ms")}`,
      `      others' duration    ${spreadText(scan.otherDurationMs, "ms")}`,
      `      rejected by glob    ${spreadText(scan.rejectedByGlob)}`,
      ...(name === "grep"
        ? [
            `      files searched      ${spreadText(scan.searchedFiles)}`,
            `      others' searched    ${spreadText(scan.otherSearchedFiles)}`,
          ]
        : []),
      `      empty, hidden prefix ${scan.hiddenPrefixEmpty}`,
      `  [B] output bytes        ${spreadText(output.bytes)}`,
      `      >= ${LARGE_OUTPUT_BYTES / 1024} KiB           ${output.large} (${pct(output.large, ok)}), output limit hit ${output.outputLimitHit}`,
      ...(name === "grep" ? [`      with clipped lines  ${output.withClippedLines}`] : []),
      `      next after large    ${counts(output.nextAfterLarge)}`,
    );
    for (const example of tool.examples.emptyWithGlobRejections)
      lines.push(`  e.g. empty, glob rejected: ${JSON.stringify(example)}`);
    for (const example of tool.examples.emptyThenShell)
      lines.push(`  e.g. empty, then shell search: ${JSON.stringify(example)}`);
    for (const example of scan.examples)
      lines.push(`  e.g. fixed-prefix glob: ${JSON.stringify(example)}`);
  }
  return lines.join("\n");
}

export function readEvents(files: readonly string[]): SearchDebugEvent[] {
  const events: SearchDebugEvent[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        events.push(JSON.parse(line) as SearchDebugEvent);
      } catch {
        // A torn final line from a crash is not worth failing the report.
      }
    }
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts));
}

function main(argv: readonly string[]): void {
  const json = argv.includes("--json");
  const paths = argv.filter((arg) => arg !== "--json" && arg !== "--");
  const active = debugFile();
  const events = readEvents(paths.length > 0 ? paths : [`${active}.1`, active]);
  const cache = new Map<string, SessionTurns | undefined>();
  const summary = summarize(events, (sessionFile) => {
    if (!cache.has(sessionFile))
      cache.set(
        sessionFile,
        existsSync(sessionFile) ? parseSessionTurns(readFileSync(sessionFile, "utf8")) : undefined,
      );
    return cache.get(sessionFile);
  });
  console.log(json ? JSON.stringify(summary, null, 2) : formatSummary(summary));
}

if (import.meta.main) main(process.argv.slice(2));
