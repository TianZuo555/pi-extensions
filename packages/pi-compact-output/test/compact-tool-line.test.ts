import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import {
  buildCompactToolLine,
  fallbackToolSummary,
  type ToolExecutionInternals,
} from "../lib/compact-tool-line.ts";
import {
  MAX_SANITIZE_INPUT,
  firstSanitizedLine,
  sanitizeCompactText,
} from "../lib/sanitize-text.ts";

class FakeComponent implements Component {
  private lines: string[];

  constructor(lines: string[]) {
    this.lines = lines;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.lines.map((line) => line.slice(0, width));
  }
}

function internals(overrides: Partial<ToolExecutionInternals> = {}): ToolExecutionInternals {
  return {
    toolName: "grep",
    args: { pattern: "/registerTool/", path: "packages" },
    isPartial: false,
    ...overrides,
  };
}

test("collapsed tool returns up to three lines", () => {
  const lines = buildCompactToolLine(
    internals({
      callRendererComponent: new FakeComponent([
        "grep /registerTool/ in packages",
        "line two",
        "line three",
        "line four",
      ]),
    }),
    120,
  );
  assert.equal(lines.length, 3);
  assert.match(lines[0], /grep \/registerTool\/ in packages/);
  assert.match(lines[1], /line two/);
  assert.match(lines[2], /line three/);
});

test("widths 120, 20, and 1 never overflow", () => {
  const source = internals({
    callRendererComponent: new FakeComponent([
      "grep /registerTool/ in packages/pi-compact-output with a very long suffix",
    ]),
    result: { isError: true, content: [{ type: "text", text: "pattern not found in workspace" }] },
  });
  for (const width of [120, 20, 1]) {
    const lines = buildCompactToolLine(source, width);
    assert.ok(lines.length >= 1 && lines.length <= 3);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}: ${lines.join(" | ")}`);
  }
});

test("pending, success, and error markers are correct", () => {
  const pending = buildCompactToolLine(internals({ isPartial: true }), 80)[0];
  const success = buildCompactToolLine(internals({ isPartial: false, result: { isError: false, content: [] } }), 80)[0];
  const error = buildCompactToolLine(
    internals({ isPartial: false, result: { isError: true, content: [{ type: "text", text: "boom" }] } }),
    80,
  )[0];
  assert.match(pending, /^🔧 /);
  assert.match(success, /^🔧 /);
  assert.match(error, /^🔧 /);
  assert.doesNotMatch(pending, /✓|✗/);
  assert.doesNotMatch(success, /✓/);
  assert.doesNotMatch(error, /✓/);
});

test("error includes a bounded first error line when space permits", () => {
  const line = buildCompactToolLine(
    internals({
      callRendererComponent: new FakeComponent(["edit packages/foo.ts"]),
      result: { isError: true, content: [{ type: "text", text: "oldText not found\nmore detail" }] },
    }),
    120,
  )[0];
  assert.match(line, /oldText not found/);
});

test("successful result output fills the remaining collapsed lines", () => {
  const lines = buildCompactToolLine(
    internals({
      callRendererComponent: new FakeComponent(["grep /registerTool/ in packages"]),
      result: {
        isError: false,
        content: [
          {
            type: "text",
            text: "packages/foo.ts:12: const x = 1\npackages/bar.ts:3: const y = 2\npackages/baz.ts:9: const z = 3",
          },
        ],
      },
    }),
    120,
  );
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "🔧 grep /registerTool/ in packages");
  assert.equal(lines[1], "packages/foo.ts:12: const x = 1");
  assert.equal(lines[2], "packages/bar.ts:3: const y = 2");
});

test("result output never replaces a three-line call renderer", () => {
  const lines = buildCompactToolLine(
    internals({
      callRendererComponent: new FakeComponent(["line one", "line two", "line three"]),
      result: { isError: false, content: [{ type: "text", text: "RESULT" }] },
    }),
    120,
  );
  assert.equal(lines.length, 3);
  assert.doesNotMatch(lines.join("\n"), /RESULT/);
});

test("result fill respects narrow widths", () => {
  const lines = buildCompactToolLine(
    internals({
      callRendererComponent: new FakeComponent(["grep /x/ in packages"]),
      result: { isError: false, content: [{ type: "text", text: "abcdefghij" }] },
    }),
    10,
  );
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => visibleWidth(line) <= 10));
});

test("intentionally hidden component stays hidden", () => {
  assert.deepEqual(buildCompactToolLine(internals({ hideComponent: true }), 80), []);
});

test("unknown-tool fallback does not stringify a secret argument", () => {
  const summary = fallbackToolSummary("custom_tool", {
    apiKey: "super-secret",
    prompt: "long hidden prompt",
  });
  assert.equal(summary, "custom_tool");
});

test("FFF-style grep/find fallbacks include pattern and path", () => {
  assert.match(
    fallbackToolSummary("grep", { pattern: "foo", path: "src" }),
    /grep foo in src/,
  );
  assert.match(
    fallbackToolSummary("ffgrep", { pattern: "foo", path: "src" }),
    /grep foo in src/,
  );
  assert.match(
    fallbackToolSummary("find", { pattern: "*.ts", path: "packages" }),
    /find \*\.ts in packages/,
  );
  assert.match(
    fallbackToolSummary("fffind", { pattern: "*.ts", path: "packages" }),
    /find \*\.ts in packages/,
  );
});

test("self-shell style component compacts from call renderer line", () => {
  const line = buildCompactToolLine(
    internals({
      toolName: "bash",
      args: { command: "npm test -w pi-tian-compact-output" },
      callRendererComponent: new FakeComponent(["$ npm test -w pi-tian-compact-output"]),
      isPartial: true,
    }),
    120,
  )[0];
  assert.match(line, /npm test -w pi-tian-compact-output/);
});

test("styled FFF-like call lines preserve trailing ANSI reset codes", () => {
  const styled = "\x1b[31mgrep needle\x1b[39m";
  const line = buildCompactToolLine(
    internals({
      callRendererComponent: new FakeComponent([styled]),
      isPartial: true,
    }),
    120,
  )[0];
  assert.equal(line, `🔧 ${styled}`);
});

test("error output strips terminal control sequences", () => {
  const line = buildCompactToolLine(
    internals({
      callRendererComponent: new FakeComponent(["edit packages/foo.ts"]),
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: "\x1b[31moldText not found\x1b[0m\x1b]0;evil\x07",
          },
        ],
      },
    }),
    120,
  )[0];
  assert.match(line, /oldText not found/);
  assert.doesNotMatch(line, /\x1b/);
  assert.doesNotMatch(line, /evil/);
});

test("fallback argument values are sanitized", () => {
  const summary = fallbackToolSummary("bash", {
    command: "echo hi\x1b[2J\x07",
  });
  assert.equal(summary, "echo hi");
});

test("sanitizeCompactText hard-caps oversized input", () => {
  const sanitized = sanitizeCompactText("x".repeat(10_000));
  assert.ok(sanitized.length <= 512);
});

test("firstSanitizedLine caps before splitting multiline errors", () => {
  const prefix = "visible error";
  const huge = `${prefix}\n${"y".repeat(20_000)}`;
  assert.equal(firstSanitizedLine(huge), prefix);
  assert.equal(firstSanitizedLine("   "), undefined);
});

test("fallback sanitization caps before scanning oversized args", () => {
  const summary = fallbackToolSummary("bash", {
    command: `echo hi${"y".repeat(20_000)}`,
  });
  assert.match(summary, /^echo hi/);
  assert.equal(fallbackToolSummary("bash", { command: " ".repeat(10_000) }), "bash");
  assert.ok(MAX_SANITIZE_INPUT < 10_000);
});
