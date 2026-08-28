import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildBarChart, buildPeakLine } from "../lib/tokens-chart.ts";
import {
  aggregateWindow,
  buildDayIndex,
  buildHourBuckets,
  formatCostCompact,
  formatTokensCompact,
  formatTokensFull,
  localDateKey,
  topModels,
  windowDayKeys,
  windowRange,
  type UsageRecord,
} from "../lib/tokens-model.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    provider: "openai-codex",
    model: "gpt-5.6",
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1100,
    costUSD: 0.01,
    ...overrides,
  };
}

test("formatTokensCompact renders K/M/B", () => {
  assert.equal(formatTokensCompact(920), "920");
  assert.equal(formatTokensCompact(12_400), "12.4K");
  assert.equal(formatTokensCompact(1_234_567), "1.2M");
  assert.equal(formatTokensCompact(10_400_000), "10.4M");
  assert.equal(formatTokensCompact(104_000_000), "104M");
  assert.equal(formatTokensCompact(1_100_000_000), "1.1B");
});

test("formatCostCompact renders dollars", () => {
  assert.equal(formatCostCompact(0), "$0");
  assert.equal(formatCostCompact(0.002), "<$0.01");
  assert.equal(formatCostCompact(39.823), "$39.82");
  assert.equal(formatCostCompact(1234.5), "$1.2K");
});

test("formatTokensFull uses separators", () => {
  assert.equal(formatTokensFull(1023), "1,023");
});

test("windowRange covers MTD and rolling windows", () => {
  const now = new Date(2026, 7, 18, 15, 30); // Aug 18 2026 local
  const mtd = windowRange("mtd", now);
  assert.equal(new Date(mtd.startMs).getDate(), 1);
  assert.equal(new Date(mtd.startMs).getMonth(), 7);

  const day7 = windowRange("7d", now);
  const day7Start = new Date(day7.startMs);
  assert.equal(day7Start.getDate(), 12); // today - 6, inclusive
  assert.equal(day7Start.getHours(), 0);

  const day30 = windowRange("30d", now);
  assert.equal(new Date(day30.startMs).getDate(), 20); // Jul 20

  const today = windowRange("1d", now);
  assert.equal(localDateKey(new Date(today.startMs)), localDateKey(now));
});

test("windowDayKeys produces continuous local day keys", () => {
  const now = new Date(2026, 7, 3);
  const keys = windowDayKeys(windowRange("mtd", now), now);
  assert.equal(keys.length, 3);
  assert.deepEqual(keys, ["2026-08-01", "2026-08-02", "2026-08-03"]);
});

test("aggregateWindow totals include empty days and per-model breakdown", () => {
  const now = new Date(2026, 7, 3, 12, 0);
  const records = [
    record({
      id: "a",
      ts: new Date(2026, 7, 1, 9, 0).getTime(),
      totalTokens: 100,
      costUSD: 1,
      provider: "p1",
      model: "m1",
    }),
    record({
      id: "b",
      ts: new Date(2026, 7, 3, 10, 0).getTime(),
      totalTokens: 50,
      costUSD: 2,
      provider: "p1",
      model: "m1",
    }),
    record({
      id: "c",
      ts: new Date(2026, 7, 3, 11, 0).getTime(),
      totalTokens: 25,
      costUSD: 4,
      provider: "p2",
      model: "m2",
    }),
  ];
  const aggregate = aggregateWindow("mtd", now, buildDayIndex(records));
  assert.equal(aggregate.totalTokens, 175);
  assert.equal(aggregate.costUSD, 7);
  assert.equal(aggregate.requests, 3);
  assert.equal(aggregate.days.length, 3); // Aug 2 stays as an empty (zero) bucket
  const byCost = topModels(aggregate.models, "cost", 2);
  assert.equal(byCost[0]?.[0], "p2/m2");
  const byTokens = topModels(aggregate.models, "tokens", 2);
  assert.equal(byTokens[0]?.[0], "p1/m1");
});

test("buildHourBuckets buckets by local hour for one dateKey", () => {
  const dateKey = "2026-08-02";
  const records = [
    record({ id: "a", ts: new Date(2026, 7, 2, 0, 30).getTime(), totalTokens: 10 }),
    record({ id: "b", ts: new Date(2026, 7, 2, 14, 0).getTime(), totalTokens: 20 }),
    record({ id: "c", ts: new Date(2026, 7, 1, 14, 0).getTime(), totalTokens: 999 }), // other day
  ];
  const buckets = buildHourBuckets(dateKey, records);
  assert.equal(buckets.length, 24);
  assert.equal(buckets[0]!.totalTokens, 10);
  assert.equal(buckets[14]!.totalTokens, 20);
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0),
    30,
  );
});

test("bar chart stays within requested width, including 42 columns", () => {
  const buckets = Array.from({ length: 30 }, (_, index) => ({
    label: `${index + 1}`,
    value: (index + 1) * 1000,
  }));
  for (const width of [42, 60, 80, 120]) {
    const lines = buildBarChart({ buckets, width });
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= width,
        `width ${width}: visible ${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`,
      );
    }
  }
});

test("bar chart drops oldest buckets when capacity is tight", () => {
  const buckets = Array.from({ length: 30 }, (_, index) => ({
    label: `${index + 1}`,
    value: index === 29 ? 5000 : 100, // newest bucket is the peak
  }));
  const lines = buildBarChart({ buckets, width: 42, rows: 4 });
  const bars = lines[0]!; // top row: only the tallest bucket(s) reach here
  assert.ok(bars.includes("█"), "peak bar reaches the top row");
});

test("bar chart keeps ANSI sequences intact", () => {
  const lines = buildBarChart({
    buckets: [
      { label: "1", value: 5 },
      { label: "2", value: 0 },
    ],
    width: 40,
    theme: { bar: (text) => `\x1b[31m${text}\x1b[39m`, label: (text) => `\x1b[2m${text}\x1b[22m` },
  });
  assert.ok(lines.some((line) => line.includes("\x1b[31m")));
  const label = lines.at(-1)!;
  assert.ok(label.includes("\x1b[2m1\x1b[22m"), `label line keeps ANSI: ${JSON.stringify(label)}`);
});

test("tick labels survive ANSI painting and anchor to the newest bucket", () => {
  const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  const paint = (text: string) => `\x1b[38;2;128;128;128m${text}\x1b[39m`;
  const buckets = Array.from({ length: 20 }, (_, index) => ({
    label: `${index + 1}`,
    value: (index * 37) % 90,
  }));
  const lines = buildBarChart({ buckets, width: 80, rows: 5, theme: { label: paint } });
  const labels = strip(lines.at(-1)!).trim().split(/\s+/);
  // Regression: ANSI-inflated cursor math dropped all but the first/last label.
  assert.ok(labels.length >= 4, `expected several labels, got ${JSON.stringify(labels)}`);
  assert.equal(labels.at(-1), "20", "newest bucket (today) is always labeled");
  assert.equal(new Set(labels).size, labels.length, "labels are not duplicated");
});

test("empty days draw nothing; bars stand on blank space", () => {
  const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  const buckets = [
    { label: "1", value: 50 },
    { label: "2", value: 0 }, // empty day
    { label: "3", value: 10 },
  ];
  const lines = buildBarChart({ buckets, width: 40, rows: 3 });
  const floor = strip(lines[lines.length - 2]!);
  // slot=3: bar(2)+gap(1). The empty bucket leaves blank space, no axis line.
  assert.equal(floor, "██    ██");
});

test("active-but-zero buckets render a tiny dim bar", () => {
  const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  const buckets = [
    { label: "1", value: 50 },
    { label: "2", value: 0, active: true }, // e.g. zero-cost provider in cost view
    { label: "3", value: 0 }, // genuinely empty
  ];
  const lines = buildBarChart({ buckets, width: 40, rows: 3 });
  const floor = strip(lines[lines.length - 2]!);
  assert.ok(floor.includes("▁"), `active zero bucket gets a tiny bar: ${JSON.stringify(floor)}`);
});

test("a tiny positive value renders a tiny bar, never nothing", () => {
  const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  const buckets = [
    { label: "1", value: 1_000_000 }, // the peak
    { label: "2", value: 1 }, // 0.0001% of peak — still visible
    { label: "3", value: 0 }, // genuinely empty
  ];
  const lines = buildBarChart({ buckets, width: 40, rows: 6 });
  const floor = strip(lines[lines.length - 2]!);
  assert.equal(floor, "██ ▁▁");
  // Rows above the floor show only the peak.
  assert.equal(strip(lines[0]!), "██");
});

test("buildPeakLine reports the max bucket", () => {
  const line = buildPeakLine(
    [
      { label: "Aug 1", value: 10 },
      { label: "Aug 2", value: 40 },
      { label: "Aug 3", value: 0 },
    ],
    (value) => formatTokensCompact(value),
  );
  assert.equal(line, "peak 40 on Aug 2");
  assert.equal(buildPeakLine([{ label: "x", value: 0 }], String), undefined);
});
