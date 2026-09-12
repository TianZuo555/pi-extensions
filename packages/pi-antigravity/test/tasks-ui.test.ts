import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgyTask } from "../lib/tasks.ts";
import { AgyTasksDashboard, agyTaskLogLines } from "../src/tasks-ui.ts";

function makeTask(overrides: Partial<AgyTask> = {}): AgyTask {
  return {
    id: "task-14",
    logPath: "/tmp/brain/conv/.system_generated/tasks/task-14.log",
    pids: [],
    ambiguous: [74951],
    orphans: [],
    description: "npm run dev -- --host 0.0.0.0 --port 5173 --strictPort",
    bytes: 4096,
    ...overrides,
  };
}

function dashboardHarness(tasks: AgyTask[]) {
  const tui = { terminal: { rows: 16 }, requestRender: () => {} } as any;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
  const keybindings = {
    getKeys: (binding: string) => [
      binding.includes("cancel") ? "esc" : binding.includes("confirm") ? "enter" : "↑",
    ],
    matches: (data: string, binding: string) =>
      (data === "enter" && binding === "tui.select.confirm") ||
      (data === "esc" && binding === "tui.select.cancel"),
  } as any;
  return new AgyTasksDashboard(
    tui,
    theme,
    keybindings,
    {
      getTasks: () => tasks,
      refresh: async () => {},
      readLog: async () => "",
    },
    { index: 0 },
    () => {},
  );
}

test("task dashboard renders width-safe rows at every width", () => {
  const dashboard = dashboardHarness([
    makeTask(),
    makeTask({ id: "task-2", pids: [1234, 5678], ambiguous: [], orphans: [42] }),
  ]);
  try {
    for (const width of [1, 2, 5, 12, 24, 50, 80]) {
      for (const line of dashboard.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `width ${width}: line overflowed (${visibleWidth(line)}): ${JSON.stringify(line)}`,
        );
      }
    }
  } finally {
    dashboard.dispose();
  }
});

test("agyTaskLogLines strips terminal escape sequences", () => {
  assert.deepEqual(agyTaskLogLines("[31mred[0m plain"), ["red plain"]);
});

test("agyTaskLogLines expands tabs and drops control chars", () => {
  assert.deepEqual(agyTaskLogLines("a\tbc"), ["a    bc"]);
});

test("agyTaskLogLines drops trailing blank lines", () => {
  assert.deepEqual(agyTaskLogLines("one\n\n\n"), ["one"]);
});

test("agyTaskLogLines falls back to (no output) for empty logs", () => {
  assert.deepEqual(agyTaskLogLines(""), ["(no output)"]);
  assert.deepEqual(agyTaskLogLines("\n\n"), ["(no output)"]);
});
