import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { registerTools, type SearchDetails } from "../lib/tools.ts";
import { resolveBinary } from "../src/binaries.ts";
import { createSearchRuntime } from "../src/runtime.ts";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { FILE_SIZE_LIMIT_NOTICE, HIDDEN_PATH_NOTICE } from "../lib/prompt.ts";

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

    const grep = await tools
      .get("grep")!
      .execute("grep", { pattern: "needle", path: "src", glob: "*.ts" }, undefined, undefined, {
        cwd: root,
      });
    assert.match(text(grep), /^1 match in 1 file/);
    assert.match(text(grep), /src\/main\.ts\n1:/);
    assert.doesNotMatch(text(grep), /main\.js/);

    const find = await tools
      .get("find")!
      .execute("find", { pattern: "*.ts", path: "src" }, undefined, undefined, { cwd: root });
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
    const grep = await tools
      .get("grep")!
      .execute("grep", { pattern: "missing" }, undefined, undefined, { cwd: root });
    assert.equal(text(grep), `No matches found.\n\n${FILE_SIZE_LIMIT_NOTICE}\n\n${HIDDEN_PATH_NOTICE}`);

    const find = await tools
      .get("find")!
      .execute("find", { pattern: "*.ts" }, undefined, undefined, { cwd: root });
    assert.equal(text(find), `No files found.\n\n${HIDDEN_PATH_NOTICE}`);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("path decoding guidance appears only for quoted paths", {
  skip: !hasRg || !hasFd || process.platform === "win32",
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-quoted-"));
  const { runtime, tools } = captureTools();
  try {
    for (const filename of ["plain.txt", 'quoted".txt']) {
      writeFileSync(path.join(root, filename), "needle\n");
      for (const kind of ["grep", "find"]) {
        const result = await tools
          .get(kind)!
          .execute(kind, { pattern: kind === "grep" ? "needle" : "*.txt" }, undefined, undefined, {
            cwd: root,
          });
        assert.equal(
          text(result).includes("JSON-decode quoted paths before read/edit"),
          filename !== "plain.txt",
        );
      }
      rmSync(path.join(root, filename));
    }
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty timeout results retain a warning even when collapsed", async () => {
  const { runtime, tools } = captureTools();
  try {
    for (const kind of ["grep", "find"] as const) {
      const result = {
        content: [{ type: "text" as const, text: "Search timed out; results are partial." }],
        details: {
          kind,
          query: "*",
          resultCount: 0,
          fileCount: 0,
          truncated: false,
          timedOut: true,
        },
      };
      for (const expanded of [false, true]) {
        const component = tools.get(kind)!.renderResult!(
          result,
          { expanded, isPartial: false },
          theme,
          { isError: false },
        );
        assert.match(component.render(80).join("\n"), /timed out/);
        for (const width of [1, 12, 42]) {
          for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
        }
      }
    }
  } finally {
    await runtime.dispose();
  }
});

test("registered grep distinguishes files, automatic context, and match-only output", { skip: !hasRg }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-modes-"));
  writeFileSync(path.join(root, "a.txt"), "before\ncall(\nafter\n");
  const { runtime, tools } = captureTools();
  try {
    const tool = tools.get("grep")!;
    for (const options of [{}, { context: 0 }, { output: "files", context: 50 }]) {
      const result = await tool.execute("grep", { pattern: "call(", literal: true, ...options }, undefined, undefined, { cwd: root });
      assert.equal(result.details.resultCount, 1);
      assert.equal(result.details.fileCount, 1);
      const auto = Object.keys(options).length === 0;
      assert.equal(text(result).includes("before"), auto);
      assert.equal(text(result).includes("automatically"), auto);
      if (options.output === "files") {
        assert.equal(text(result), "1 file\n\na.txt");
        assert.match(tool.renderResult!(result, { expanded: false, isPartial: false }, theme, { isError: false }).render(80).join("\n"), /1 file/);
      }
      for (const expanded of [false, true]) {
        const component = tool.renderResult!(result, { expanded, isPartial: false }, theme, { isError: false });
        for (const width of [1, 12, 42]) {
          for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
        }
      }
    }
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("large explicit context cannot hide matches or exceed the model byte budget", { skip: !hasRg }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-context-budget-"));
  const lines = Array.from({ length: 110 }, (_, i) => i === 51 ? "needle" : "中".repeat(400));
  writeFileSync(path.join(root, "a.txt"), lines.join("\n"));
  const { runtime, tools } = captureTools();
  try {
    const result = await tools.get("grep")!.execute("grep", { pattern: "needle", context: 50 }, undefined, undefined, { cwd: root });
    assert.match(text(result), /52: needle/);
    assert.match(text(result), /Context omitted/);
    assert.match(text(result), /partial results/);
    assert.equal(result.details.resultCount, 1);
    assert.equal(result.details.truncated, true);
    assert.ok(Buffer.byteLength(text(result)) <= DEFAULT_MAX_BYTES);
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
        output: "files",
        literal: true,
        context: 50,
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
