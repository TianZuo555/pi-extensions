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
