import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { registerTools, type SearchDetails } from "../lib/tools.ts";
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
  readonly renderCall?: (args: unknown, theme: Theme) => Component;
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

function text(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

const theme = {
  fg(_color: string, value: string) {
    return value;
  },
  bold(value: string) {
    return value;
  },
} as unknown as Theme;

const hasRg = resolveBinary("rg") !== null;
const hasFd = resolveBinary("fd") !== null;

test("registered grep and find execute the narrow contracts", {
  skip: !hasRg || !hasFd,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-tools-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "main.ts"), "const needle = true;\n");
  writeFileSync(path.join(root, "src", "main.js"), "const needle = false;\n");
  const { runtime, tools } = captureTools();
  try {
    assert.deepEqual([...tools.keys()], ["grep", "find"]);

    const grep = await tools.get("grep")!.execute(
      "grep",
      { pattern: "needle", path: "src", glob: "*.ts" },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.match(text(grep), /^1 match in 1 file/);
    assert.match(text(grep), /src\/main\.ts:1:/);
    assert.doesNotMatch(text(grep), /main\.js/);

    const find = await tools.get("find")!.execute(
      "find",
      { pattern: "*.ts", path: "src" },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.match(text(find), /^1 file/);
    assert.match(text(find), /src\/main\.ts/);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty searches return short model-visible answers", {
  skip: !hasRg || !hasFd,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-empty-"));
  writeFileSync(path.join(root, "file.txt"), "value\n");
  const { runtime, tools } = captureTools();
  try {
    const grep = await tools.get("grep")!.execute(
      "grep",
      { pattern: "missing" },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.equal(text(grep), "No matches found.");

    const find = await tools.get("find")!.execute(
      "find",
      { pattern: "*.ts" },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.equal(text(find), "No files found.");
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom renderers remain width-safe", () => {
  const { runtime, tools } = captureTools();
  try {
    const grepCall = tools.get("grep")!.renderCall!(
      {
        pattern: "a-very-long-pattern-that-keeps-going",
        path: "packages/pi-find/src/a-very-long-directory",
        glob: "**/*.typescript",
      },
      theme,
    );
    const findCall = tools.get("find")!.renderCall!(
      {
        pattern: "**/a-very-long-file-pattern/**/*.typescript",
        path: "packages/pi-find/src/a-very-long-directory",
      },
      theme,
    );

    for (const component of [grepCall, findCall]) {
      for (const line of component.render(42)) {
        assert.ok(visibleWidth(line) <= 42, `line exceeds width: ${line}`);
      }
    }
  } finally {
    void runtime.dispose();
  }
});
