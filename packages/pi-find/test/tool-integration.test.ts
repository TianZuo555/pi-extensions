import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_MAX_BYTES,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import {
  registerTools,
  type SearchDetails,
} from "../lib/tools.ts";
import { resolveBinary } from "../src/binaries.ts";
import { createSearchRuntime } from "../src/runtime.ts";

interface CapturedTool {
  readonly name: string;
  readonly execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: { cwd: string },
  ) => Promise<AgentToolResult<SearchDetails>>;
  readonly renderCall?: (
    args: any,
    theme: Theme,
  ) => Component;
  readonly renderResult?: (
    result: AgentToolResult<unknown>,
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: { isError: boolean },
  ) => Component;
}

function captureTools() {
  const runtime = createSearchRuntime();
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool as unknown as CapturedTool);
    },
  } as unknown as ExtensionAPI;
  registerTools(pi, runtime);
  return { runtime, tools };
}

const theme = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
} as unknown as Theme;

const hasRg = resolveBinary("rg") !== null;
const hasFd = resolveBinary("fd") !== null;

test("grep tells the model when the match limit hides results", {
  skip: !hasRg,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-tool-grep-"));
  const { runtime, tools } = captureTools();
  try {
    writeFileSync(
      path.join(root, "many.ts"),
      Array.from({ length: 8 }, (_, index) => `needle ${index}`).join("\n"),
    );
    const grep = tools.get("grep")!;
    const result = await grep.execute(
      "grep-limit",
      { pattern: "needle", limit: 2 },
      undefined,
      undefined,
      { cwd: root },
    );
    const output = result.content[0];
    assert.equal(output?.type, "text");
    assert.match(output?.type === "text" ? output.text : "", /Result limit reached at 2 matches/);
    assert.equal(result.details?.truncated, true);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("find tells the model when the file limit hides results", {
  skip: !hasFd,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-tool-find-"));
  const { runtime, tools } = captureTools();
  try {
    for (let index = 0; index < 8; index++) {
      writeFileSync(path.join(root, `file-${index}.ts`), "x\n");
    }
    const find = tools.get("find")!;
    const result = await find.execute(
      "find-limit",
      { pattern: "file", limit: 2 },
      undefined,
      undefined,
      { cwd: root },
    );
    const output = result.content[0];
    assert.equal(output?.type, "text");
    assert.match(output?.type === "text" ? output.text : "", /Result limit reached at 2 files/);
    assert.equal(result.details?.truncated, true);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("grep matches extensionless filenames through the tool", {
  skip: !hasRg,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-tool-extless-"));
  const { runtime, tools } = captureTools();
  try {
    writeFileSync(path.join(root, "Dockerfile"), "FROM node:26\n");
    const grep = tools.get("grep")!;
    const result = await grep.execute(
      "grep-extless",
      { pattern: "FROM", path: "Dockerfile" },
      undefined,
      undefined,
      { cwd: root },
    );
    const output = result.content[0];
    assert.equal(output?.type, "text");
    assert.match(output?.type === "text" ? output.text : "", /Dockerfile/);
    assert.equal(result.details?.resultCount, 1);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("grep supports an array of patterns in one call", {
  skip: !hasRg,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-tool-array-"));
  const { runtime, tools } = captureTools();
  try {
    writeFileSync(path.join(root, "code.ts"), "const user_id = 1;\nconst userId = 2;\n");
    const grep = tools.get("grep")!;
    const result = await grep.execute(
      "grep-array",
      { pattern: ["user_id", "userId"] },
      undefined,
      undefined,
      { cwd: root },
    );
    const output = result.content[0];
    assert.equal(output?.type, "text");
    assert.match(output?.type === "text" ? output.text : "", /user_id/);
    assert.match(output?.type === "text" ? output.text : "", /userId/);
    assert.equal(result.details?.resultCount, 2);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("grep pages by bytes and outputs plain truncation notice without cursor", {
  skip: !hasRg,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-tool-page-"));
  const { runtime, tools } = captureTools();
  try {
    const longSuffix = "🙂".repeat(260);
    writeFileSync(
      path.join(root, "wide.ts"),
      Array.from({ length: 100 }, (_, index) => `needle ${index} ${longSuffix}`).join("\n"),
    );
    const grep = tools.get("grep")!;
    const result = await grep.execute(
      "grep-page-1",
      { pattern: "needle", limit: 200 },
      undefined,
      undefined,
      { cwd: root },
    );
    const output = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.ok(Buffer.byteLength(output, "utf8") <= DEFAULT_MAX_BYTES);
    assert.match(output, /Showing \d+ of \d+ output lines \(\d+ more lines omitted\)/);
    assert.doesNotMatch(output, /cursor=/);
    assert.equal(result.details?.truncated, true);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("single-element array pattern searches literally without regex or wildcard errors", {
  skip: !hasRg,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-tool-single-arr-"));
  const { runtime, tools } = captureTools();
  try {
    writeFileSync(path.join(root, "meta.ts"), "const dotStar = '.*';\nconst call = 'needle(arg';\n");
    const grep = tools.get("grep")!;

    const dotStarResult = await grep.execute(
      "grep-dotstar",
      { pattern: [".*"] },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.equal(dotStarResult.details?.resultCount, 1);
    assert.match(dotStarResult.content[0]?.type === "text" ? dotStarResult.content[0].text : "", /\.\*/);

    const callResult = await grep.execute(
      "grep-call",
      { pattern: ["needle(arg"] },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.equal(callResult.details?.resultCount, 1);
    assert.match(callResult.content[0]?.type === "text" ? callResult.content[0].text : "", /needle\(arg/);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stringified-array pattern runs as written but carries the resend notice", {
  skip: !hasRg,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-tool-stringified-"));
  const { runtime, tools } = captureTools();
  try {
    // The character class ["a", "b"] matches almost any code line, so the
    // notice must ride along on the noisy match path, not only on no-match.
    writeFileSync(path.join(root, "code.ts"), "const answer = 42;\n");
    const grep = tools.get("grep")!;

    const noisy = await grep.execute(
      "grep-stringified",
      { pattern: '["a", "b"]' },
      undefined,
      undefined,
      { cwd: root },
    );
    const noisyText = noisy.content[0]?.type === "text" ? noisy.content[0].text : "";
    assert.match(noisyText, /JSON array sent as a string/);
    assert.match(noisyText, /real array/);

    // A legitimate regex character class that is not JSON stays notice-free.
    const clean = await grep.execute(
      "grep-class",
      { pattern: "[abc]" },
      undefined,
      undefined,
      { cwd: root },
    );
    const cleanText = clean.content[0]?.type === "text" ? clean.content[0].text : "";
    assert.doesNotMatch(cleanText, /JSON array sent as a string/);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("out-of-range context and limit clamp with a notice instead of failing", {
  skip: !hasRg,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-tool-clamp-"));
  const { runtime, tools } = captureTools();
  try {
    // Reproduces a real session failure: a model sent context=45 (max 20)
    // and pi rejected the whole call with a validation error.
    writeFileSync(
      path.join(root, "code.ts"),
      Array.from({ length: 39 }, (_, index) => `filler ${index}`).join("\n") +
        "\nobjective line is injected here\n",
    );
    const grep = tools.get("grep")!;
    const result = await grep.execute(
      "grep-clamp",
      { pattern: "objective line", context: 45, limit: 5000 },
      undefined,
      undefined,
      { cwd: root },
    );
    const output = result.content[0];
    assert.equal(output?.type, "text");
    const text = output?.type === "text" ? output.text : "";
    assert.match(text, /context=45 is outside 0–20; ran with context=20/);
    assert.match(text, /limit=5000 is outside 1–1000; ran with limit=1000/);
    assert.match(text, /1 match in 1 file/);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the custom renderer satisfies TUI width safety at 42 columns", async () => {
  const { runtime, tools } = captureTools();
  try {
    const grep = tools.get("grep")!;

    // 1. Failure rendering
    const failureRendered = grep.renderResult!(
      {
        content: [{ type: "text", text: "rg failed: very long error message that exceeds narrow terminal column width easily" }],
        details: undefined,
      },
      { expanded: true, isPartial: false },
      theme,
      { isError: true },
    ).render(42);
    for (const line of failureRendered) {
      assert.ok(visibleWidth(line) <= 42, `line exceeds 42 cols: "${line}"`);
    }

    // 2. Success result rendering
    const successRendered = grep.renderResult!(
      {
        content: [{ type: "text", text: "1 match in 1 file\n\nsrc/file.ts\n   1: const x = 1;" }],
        details: { kind: "grep", query: "x", resultCount: 1, fileCount: 1, truncated: false },
      },
      { expanded: true, isPartial: false },
      theme,
      { isError: false },
    ).render(42);
    for (const line of successRendered) {
      assert.ok(visibleWidth(line) <= 42, `line exceeds 42 cols: "${line}"`);
    }

    // 3. Truncated result rendering
    const truncatedRendered = grep.renderResult!(
      {
        content: [{ type: "text", text: "100 matches in 50 files\n\n[Showing 20 of 100 output lines (80 more lines omitted)]" }],
        details: { kind: "grep", query: "x", resultCount: 100, fileCount: 50, truncated: true },
      },
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    ).render(42);
    for (const line of truncatedRendered) {
      assert.ok(visibleWidth(line) <= 42, `line exceeds 42 cols: "${line}"`);
    }

    // 4. renderCall for grep and find
    const grepCallRendered = grep.renderCall!(
      { pattern: ["a", "b", "c", "d", "e"], path: "packages/pi-find/src/" },
      theme,
    ).render(42);
    for (const line of grepCallRendered) {
      assert.ok(visibleWidth(line) <= 42, `line exceeds 42 cols: "${line}"`);
    }

    // 5. partial / streaming renderCall with empty or undefined arguments
    const emptyGrepRendered = grep.renderCall!({}, theme).render(42);
    for (const line of emptyGrepRendered) {
      assert.ok(visibleWidth(line) <= 42, `line exceeds 42 cols: "${line}"`);
    }

    const undefinedGrepRendered = grep.renderCall!({ pattern: undefined, path: undefined }, theme).render(42);
    for (const line of undefinedGrepRendered) {
      assert.ok(visibleWidth(line) <= 42, `line exceeds 42 cols: "${line}"`);
    }

    const find = tools.get("find")!;
    const emptyFindRendered = find.renderCall!({}, theme).render(42);
    for (const line of emptyFindRendered) {
      assert.ok(visibleWidth(line) <= 42, `line exceeds 42 cols: "${line}"`);
    }

    const undefinedFindRendered = find.renderCall!({ pattern: undefined, path: undefined }, theme).render(42);
    for (const line of undefinedFindRendered) {
      assert.ok(visibleWidth(line) <= 42, `line exceeds 42 cols: "${line}"`);
    }
  } finally {
    await runtime.dispose();
  }
});
