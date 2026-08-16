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
  const root = mkdtempSync(path.join(tmpdir(), "pi-search-tool-grep-"));
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
  const root = mkdtempSync(path.join(tmpdir(), "pi-search-tool-find-"));
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
  const root = mkdtempSync(path.join(tmpdir(), "pi-search-tool-extless-"));
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

test("a cursor sent with a different query is rejected but not consumed", {
  skip: !hasRg,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-search-tool-mismatch-"));
  const { runtime, tools } = captureTools();
  try {
    // More matches than one grep page holds, so the result issues a cursor.
    writeFileSync(
      path.join(root, "many.ts"),
      Array.from({ length: 200 }, (_, index) => `needle ${index}`).join("\n"),
    );
    const grep = tools.get("grep")!;
    const first = await grep.execute(
      "grep-mismatch-1",
      { pattern: "needle", limit: 200 },
      undefined,
      undefined,
      { cwd: root },
    );
    const firstText = first.content[0]?.type === "text" ? first.content[0].text : "";
    const cursor = /cursor="([^"]+)"/.exec(firstText)?.[1];
    assert.ok(cursor, "expected the overflow notice to issue a cursor");

    const wrong = await grep.execute(
      "grep-mismatch-2",
      { pattern: "other", cursor },
      undefined,
      undefined,
      { cwd: root },
    );
    const wrongOutput = wrong.content[0];
    assert.equal(wrongOutput?.type, "text");
    assert.match(
      wrongOutput?.type === "text" ? wrongOutput.text : "",
      /different query/,
    );
    assert.doesNotMatch(
      wrongOutput?.type === "text" ? wrongOutput.text : "",
      /needle/,
    );
    assert.equal(wrong.details?.cursorStatus, "mismatch");

    // The mismatch did not consume the cursor: the original query still pages.
    const right = await grep.execute(
      "grep-mismatch-3",
      { pattern: "needle", cursor },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.equal(right.details?.cursorStatus, "continued");
    const rightOutput = right.content[0];
    assert.match(
      rightOutput?.type === "text" ? rightOutput.text : "",
      /needle 1[2-9][0-9]/,
    );
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi_grep cursor keys preserve pattern boundaries", {
  skip: !hasRg,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-search-tool-query-key-"));
  const { runtime, tools } = captureTools();
  try {
    writeFileSync(
      path.join(root, "many.ts"),
      Array.from({ length: 200 }, (_, index) => `a, b ${index}`).join("\n"),
    );
    const multiGrep = tools.get("multi_grep")!;
    const first = await multiGrep.execute(
      "multi-grep-key-1",
      { patterns: ["a, b"], limit: 200 },
      undefined,
      undefined,
      { cwd: root },
    );
    const firstText = first.content[0]?.type === "text" ? first.content[0].text : "";
    const cursor = /cursor="([^"]+)"/.exec(firstText)?.[1];
    assert.ok(cursor, "expected the overflow notice to issue a cursor");

    // Joining with a comma would make these distinct pattern arrays collide.
    const wrong = await multiGrep.execute(
      "multi-grep-key-2",
      { patterns: ["a", "b"], cursor },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.equal(wrong.details?.cursorStatus, "mismatch");

    // A mismatch must leave the cursor available to its actual owner.
    const right = await multiGrep.execute(
      "multi-grep-key-3",
      { patterns: ["a, b"], cursor },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.equal(right.details?.cursorStatus, "continued");
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("grep pages by bytes and expanded cursor output remains inspectable", {
  skip: !hasRg,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-search-tool-page-"));
  const { runtime, tools } = captureTools();
  try {
    const longSuffix = "🙂".repeat(260);
    writeFileSync(
      path.join(root, "wide.ts"),
      Array.from({ length: 100 }, (_, index) => `needle ${index} ${longSuffix}`).join("\n"),
    );
    const grep = tools.get("grep")!;
    const first = await grep.execute(
      "grep-page-1",
      { pattern: "needle", limit: 200 },
      undefined,
      undefined,
      { cwd: root },
    );
    const firstOutput = first.content[0]?.type === "text" ? first.content[0].text : "";
    assert.ok(Buffer.byteLength(firstOutput, "utf8") <= DEFAULT_MAX_BYTES);
    const cursor = /cursor="([^"]+)"/.exec(firstOutput)?.[1];
    assert.ok(cursor, "expected byte pagination to issue a cursor");

    const second = await grep.execute(
      "grep-page-2",
      { pattern: "needle", cursor },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.equal(second.details?.cursorStatus, "continued");
    const renderer = grep.renderResult!;
    const expanded = renderer(
      second,
      { expanded: true, isPartial: false },
      theme,
      { isError: false },
    ).render(42);
    assert.match(expanded.join("\n"), /continued results/);
    assert.match(expanded.join("\n"), /needle/);
    for (const line of expanded) assert.ok(visibleWidth(line) <= 42, line);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the custom renderer presents failures as failures", async () => {
  const { runtime, tools } = captureTools();
  try {
    const grep = tools.get("grep")!;
    const rendered = grep.renderResult!(
      {
        content: [{ type: "text", text: "rg failed: bad pattern" }],
        details: undefined,
      },
      { expanded: false, isPartial: false },
      theme,
      { isError: true },
    ).render(42).join("\n");
    assert.match(rendered, /✗ rg failed: bad pattern/);
    assert.doesNotMatch(rendered, /completed/);
  } finally {
    await runtime.dispose();
  }
});
