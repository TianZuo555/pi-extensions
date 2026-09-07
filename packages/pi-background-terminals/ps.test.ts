import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  openTerminalPicker,
  buildTerminalInvocationInfo,
  cycleTerminalDetailTab,
  DEFAULT_TERMINAL_DETAIL_TAB,
  reconcileDashboardSelection,
  type DashboardSelection,
} from "./src/ui/ps.ts";
import { buildOutputLines, createOutputLineCache, sanitizeText } from "./src/ui/output-view.ts";

for (const diskBacked of [false, true]) {
  test(`detail scrolling freezes ${diskBacked ? "spill" : "retained"} output until G`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bt-view-test-"));
    const file = path.join(dir, "output");
    const original = Array.from({ length: 2000 }, (_, i) => `line-${i}`).join("\n") + "\n";
    await fs.writeFile(file, original);
    const output = {
      text: original,
      head: original,
      tail: "",
      totalBytes: original.length,
      truncatedBytes: diskBacked ? 1 : 0,
      spillPath: diskBacked ? file : undefined,
    };
    const snap = {
      id: "bt-0123456789abcdef-1",
      command: "test",
      title: "test",
      cwd: dir,
      createdAt: Date.now(),
      status: "running" as const,
      stdout: output,
      stderr: output,
    };
    const view = {
      size: () => 1,
      list: () => [snap],
      get: () => snap,
      subscribe: () => () => {},
      subscribeTo: () => () => {},
      requestKill: () => {},
      setOnSettled: () => {},
    };
    let customCalls = 0;
    const ctx = {
      ui: {
        custom: async (factory: any) => {
          const component = factory(
            { terminal: { rows: 30 }, requestRender() {} },
            { fg: (_: string, text: string) => text, bold: (text: string) => text },
            { matches: () => false, getKeys: () => [] },
            () => {},
          );
          try {
            if (++customCalls !== 2) return customCalls === 1 ? snap.id : null;
            component.handleInput("t");
            const deadline = Date.now() + 3000;
            while (diskBacked && !component.render(100).join("\n").includes("full log (live)")) {
              assert.ok(Date.now() < deadline, "spill loaded");
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            component.render(100);
            component.handleInput("k");
            const visible = () =>
              component.render(100).filter((line: string) => /^ {2}(line-|new-)/.test(line));
            const before = visible();
            assert.ok(before.length > 0);
            const growth = Array.from({ length: 100 }, (_, i) => `new-${i}`).join("\n") + "\n";
            output.text += growth;
            output.totalBytes += growth.length;
            await fs.appendFile(file, growth);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            assert.deepEqual(visible(), before, "reading position must remain stable");
            component.handleInput("G");
            const resumedDeadline = Date.now() + 3000;
            while (!visible().some((line: string) => line.includes("new-99"))) {
              assert.ok(Date.now() < resumedDeadline, "G resumes live output");
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            return null;
          } finally {
            component.dispose();
          }
        },
      },
    } as unknown as Parameters<typeof openTerminalPicker>[0];
    try {
      await openTerminalPicker(ctx, view);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

for (const transition of ["initial-load", "retention-overflow"] as const) {
  test(`paused ${transition} still permits complete spill paging`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bt-paused-paging-"));
    const file = path.join(dir, "output");
    const complete = Array.from(
      { length: 12_000 },
      (_, i) => `archive-${i}: ${"x".repeat(200)}\n`,
    ).join("");
    const retained = complete.split("\n").slice(-100).join("\n");
    const initial = "retained line\n".repeat(100);
    await fs.writeFile(file, transition === "initial-load" ? complete : initial);
    const output = {
      text: transition === "initial-load" ? retained : initial,
      head: "",
      tail: "",
      totalBytes: transition === "initial-load" ? complete.length : initial.length,
      truncatedBytes: transition === "initial-load" ? complete.length - retained.length : 0,
      spillPath: file,
    };
    const snap = {
      id: "bt-0123456789abcdef-1",
      command: "test",
      title: "test",
      cwd: dir,
      createdAt: Date.now(),
      status: "running" as const,
      stdout: output,
      stderr: output,
    };
    const view = {
      size: () => 1,
      list: () => [snap],
      get: () => snap,
      subscribe: () => () => {},
      subscribeTo: () => () => {},
      requestKill: () => {},
      setOnSettled: () => {},
    };
    let customCalls = 0;
    const ctx = {
      ui: {
        custom: async (factory: any) => {
          const component = factory(
            { terminal: { rows: 30 }, requestRender() {} },
            { fg: (_: string, text: string) => text, bold: (text: string) => text },
            { matches: () => false, getKeys: () => [] },
            () => {},
          );
          try {
            if (++customCalls !== 2) return customCalls === 1 ? snap.id : null;
            const render = (): string => component.render(250).join("\n");
            const until = async (predicate: () => boolean, label: string) => {
              const deadline = Date.now() + 5000;
              while (!predicate()) {
                assert.ok(Date.now() < deadline, label);
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            };
            component.handleInput("t");
            render();
            // No await: k always arrives before the initial asynchronous window commits.
            component.handleInput("k");
            render();
            if (transition === "retention-overflow") {
              await fs.writeFile(file, complete);
              output.text = retained;
              output.totalBytes = complete.length;
              output.truncatedBytes = complete.length - retained.length;
            }
            component.handleInput("g");
            await until(
              () => render().includes("full log · showing"),
              "paused initial disk load completes",
            );
            assert.doesNotMatch(render(), /full log \(live\)/);
            // g can keep walking backward from the loaded window to byte zero,
            // without G or tab switching and without exposing only the retained tail.
            for (let page = 0; page < 5 && !render().includes("archive-0:"); page++) {
              const range = () =>
                render()
                  .split("\n")
                  .find((line) => line.includes("full log · showing"));
              const before = range();
              component.handleInput("g");
              await until(
                () => range() !== before || render().includes("archive-0:"),
                "backward paging advances",
              );
            }
            assert.match(render(), /archive-0:/);
            assert.doesNotMatch(render(), /full log \(live\)/);
            const beforeGrowth = render()
              .split("\n")
              .filter((line) => line.startsWith("  archive-"));
            await fs.appendFile(file, "later output\n".repeat(100));
            await new Promise((resolve) => setTimeout(resolve, 1500));
            assert.deepEqual(
              render()
                .split("\n")
                .filter((line) => line.startsWith("  archive-")),
              beforeGrowth,
            );
            return null;
          } finally {
            component.dispose();
          }
        },
      },
    } as unknown as Parameters<typeof openTerminalPicker>[0];
    try {
      await openTerminalPicker(ctx, view);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

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
