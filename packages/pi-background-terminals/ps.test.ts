import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTerminalInvocationInfo,
  cycleTerminalDetailTab,
  DEFAULT_TERMINAL_DETAIL_TAB,
  reconcileDashboardSelection,
  type DashboardSelection,
} from "./src/ui/ps.ts";
import { buildOutputLines, createOutputLineCache, sanitizeText } from "./src/ui/output-view.ts";

test("dashboard selection follows its terminal id and falls back by row", () => {
  const selection: DashboardSelection = { id: "bt-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "bt-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `bt-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "bt-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `bt-${index + 1}` })),
    { id: "bt-8" },
    { id: "bt-9" },
  ]);
  assert.deepEqual(selection, { id: "bt-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "bt-1" }, { id: "bt-2" }]);
  assert.deepEqual(selection, { id: "bt-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("terminal detail tabs start on Info and cycle before stdout/stderr", () => {
  assert.equal(DEFAULT_TERMINAL_DETAIL_TAB, "info");
  assert.equal(cycleTerminalDetailTab("info"), "stdout");
  assert.equal(cycleTerminalDetailTab("stdout"), "stderr");
  assert.equal(cycleTerminalDetailTab("stderr"), "info");
  assert.equal(cycleTerminalDetailTab("info", -1), "stderr");
});

test("invocation info includes execution metadata but not captured output", () => {
  const info = buildTerminalInvocationInfo({
    id: "bt-7",
    command: "printf hello\nprintf world",
    title: "invoke info",
    cwd: "/tmp/project",
    pid: 123,
    status: "done",
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
    settledAt: Date.parse("2026-01-01T00:00:02.000Z"),
    timeoutMs: 5_000,
    exitCode: 0,
    stdout: {
      text: "hidden stdout",
      head: "hidden stdout",
      tail: "",
      totalBytes: 13,
      truncatedBytes: 0,
      spillPath: "/tmp/bt-7.stdout.log",
    },
    stderr: {
      text: "hidden stderr",
      head: "hidden stderr",
      tail: "",
      totalBytes: 13,
      truncatedBytes: 0,
    },
  });

  assert.match(info, /id: bt-7/);
  assert.match(info, /working directory: \/tmp\/project/);
  assert.match(info, /started: 2026-01-01T00:00:00.000Z/);
  assert.match(info, /settled: 2026-01-01T00:00:02.000Z/);
  assert.match(info, /timeout: 5s/);
  assert.match(info, /exit: exit 0/);
  assert.match(info, /command:\nprintf hello\nprintf world/);
  assert.match(info, /full log: \/tmp\/bt-7.stdout.log/);
  assert.doesNotMatch(info, /hidden stdout|hidden stderr/);
});

test("sanitizeText strips ANSI, tabs, and control characters", () => {
  assert.equal(sanitizeText("\u001b[31mred\u001b[0m"), "red");
  assert.equal(sanitizeText("\u001b[12345Cshifted"), "shifted");
  assert.equal(sanitizeText("\u001b]0;window title\u0007output"), "output");
  assert.equal(sanitizeText("\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\"), "link");
  assert.equal(sanitizeText("\u001b]0;title\u009coutput"), "output");
  assert.equal(sanitizeText("\u009d0;title\u0007output"), "output");
  assert.equal(sanitizeText("a\u0085b"), "ab");
  assert.equal(sanitizeText("a\tb"), "a  b");
  assert.equal(sanitizeText("a\u0007b\u0000c"), "abc");
});

test("output line cache reuses a version/width key and invalidates either dimension", () => {
  const cache = createOutputLineCache();
  const first = cache.get("first", 1, 80);
  const sameKey = cache.get("different text is intentionally ignored", 1, 80);
  assert.equal(sameKey, first);
  assert.deepEqual(sameKey, ["first"]);

  const newVersion = cache.get("second", 2, 80);
  assert.notEqual(newVersion, first);
  assert.deepEqual(newVersion, ["second"]);

  const newWidth = cache.get("x".repeat(25), 2, 10);
  assert.notEqual(newWidth, newVersion);
  assert.ok(newWidth.length > 1);
});

test("buildOutputLines wraps long lines and keeps only the final CR segment", () => {
  const lines = buildOutputLines("progress 1\rprogress 2\rdone\nnext", 80);
  assert.deepEqual(lines, ["done", "next"]);
  assert.deepEqual(buildOutputLines("progress 1\rprogress 2\r", 80), ["progress 2"]);

  const wrapped = buildOutputLines("x".repeat(25), 10);
  assert.ok(wrapped.length > 1);
  assert.equal(wrapped.join(""), "x".repeat(25));
});

test("buildOutputLines drops one trailing empty line from a trailing newline", () => {
  assert.deepEqual(buildOutputLines("a\nb\n", 80), ["a", "b"]);
  assert.deepEqual(buildOutputLines("a\n\n", 80), ["a", ""]);
});
