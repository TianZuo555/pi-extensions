import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createLatestPlanRefresh, renderDevinPlanLines } from "../src/plan-ui.ts";
import type { DevinPlanEntry } from "../src/turn.ts";

const ESC = "\u001b";
const identity = { fg: (_color: string, text: string) => text } as unknown as Theme;
const tagged = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("renderDevinPlanLines renders header progress and per-status icons", () => {
  const lines = renderDevinPlanLines(
    [
      { content: "A", status: "completed" },
      { content: "B", status: "in_progress" },
      { content: "C", status: "pending" },
      { content: "D" },
    ],
    tagged,
    80,
  );
  assert.deepEqual(lines, [
    "<accent> todo_write </accent><muted>1/4</muted>",
    "  ✓ <dim>A</dim>",
    "  ◉ <warning>B</warning>",
    "  ○ C",
    "  ○ D",
  ]);
});

test("renderDevinPlanLines never exceeds the widget width", () => {
  const lines = renderDevinPlanLines(
    [
      { content: "x".repeat(200), status: "in_progress" },
      { content: "short", status: "pending" },
    ],
    identity,
    30,
  );
  assert.equal(lines.length, 3);
  for (const line of lines) assert.ok(visibleWidth(line) <= 30);
});

test("renderDevinPlanLines sanitizes terminal escapes and collapses whitespace", () => {
  const lines = renderDevinPlanLines(
    [{ content: `${ESC}[31mred${ESC}[0m\nline   two`, status: "pending" }],
    identity,
    80,
  );
  assert.equal(lines[1], "  ○ red line two");
  for (const line of lines) assert.ok(!line.includes(ESC));
});

test("plan refresh ignores older snapshots that resolve after newer ones", async () => {
  const first = deferred<DevinPlanEntry[] | undefined>();
  const second = deferred<DevinPlanEntry[] | undefined>();
  const reads = [first.promise, second.promise];
  const published: DevinPlanEntry[][] = [];
  const refresh = createLatestPlanRefresh(
    () => reads.shift()!,
    (entries) => published.push(entries),
  );
  const older = refresh.refresh();
  const newer = refresh.refresh();
  second.resolve([{ content: "new" }]);
  await newer;
  first.resolve([{ content: "old" }]);
  await older;
  assert.deepEqual(published, [[{ content: "new" }]]);
});

test("plan refresh invalidation prevents a late update after shutdown", async () => {
  const pending = deferred<DevinPlanEntry[] | undefined>();
  const published: DevinPlanEntry[][] = [];
  const refresh = createLatestPlanRefresh(
    () => pending.promise,
    (entries) => published.push(entries),
  );
  const inFlight = refresh.refresh();
  refresh.invalidate();
  pending.resolve([{ content: "stale" }]);
  await inFlight;
  assert.deepEqual(published, []);
});
