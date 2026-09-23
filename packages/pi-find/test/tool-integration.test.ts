import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { registerTools, type SearchDetails } from "../lib/tools.ts";
import { resolveBinary } from "../src/binaries.ts";
import { createSearchRuntime } from "../src/runtime.ts";
import { FILE_SIZE_LIMIT_NOTICE, HIDDEN_PATH_NOTICE, SLASH_GLOB_NOTICE } from "../lib/prompt.ts";

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
    assert.equal(
      text(grep),
      `No matches found.\n\n${FILE_SIZE_LIMIT_NOTICE}\n\n${HIDDEN_PATH_NOTICE}`,
    );

    const find = await tools
      .get("find")!
      .execute("find", { pattern: "*.ts" }, undefined, undefined, { cwd: root });
    assert.equal(text(find), `No files found.\n\n${HIDDEN_PATH_NOTICE}`);
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty results hint at slash-glob bases and name files mode", {
  skip: !hasRg || !hasFd,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-slashglob-"));
  mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  writeFileSync(path.join(root, "src", "main.ts"), "needle\n");
  writeFileSync(path.join(root, "src", "deep", "x.ts"), "needle\n");
  const { runtime, tools } = captureTools();
  try {
    const grep = tools.get("grep")!;
    const run = (params: Record<string, unknown>) =>
      grep.execute("grep", params, undefined, undefined, { cwd: root }).then(text);
    // A slash glob that repeats the explicit path points below the root; the
    // hint offers the corrected glob instead of restating the rule.
    const scoped = await run({ pattern: "needle", path: "src", glob: "src/**/*.ts" });
    assert.match(scoped, /^No matches found\./);
    assert.ok(scoped.includes('[Glob "src/**/*.ts" is relative to path "src"; try "**/*.ts".]'));
    assert.ok(!scoped.includes(SLASH_GLOB_NOTICE));
    const negated = await run({ pattern: "needle", path: "./src/", glob: "!src/**/*.ts" });
    assert.match(negated, /^2 matches/, "a redundant negated prefix excludes nothing");

    // A slash glob with a different base gets the general rule.
    const otherBase = await run({ pattern: "needle", path: "src", glob: "lib/*.ts" });
    assert.ok(otherBase.includes(SLASH_GLOB_NOTICE));

    // No candidate rejected by the glob, or the root is the cwd: the glob is not the cause.
    for (const params of [
      { pattern: "absent", path: "src", glob: "src/*.ts" },
      { pattern: "needle", path: ".", glob: "lib/*.ts" },
    ]) {
      const quiet = await run(params);
      assert.match(quiet, /^No matches found\./);
      assert.ok(!quiet.includes(SLASH_GLOB_NOTICE), JSON.stringify(params));
      assert.ok(!quiet.includes("[Glob "), JSON.stringify(params));
    }

    // Traversal hints are omitted where traversal rules did not apply.
    mkdirSync(path.join(root, ".github"));
    writeFileSync(path.join(root, ".github", "ci.yml"), "on: push\n");
    const hidden = await run({ pattern: "absent", path: "@.github" });
    assert.ok(hidden.includes(FILE_SIZE_LIMIT_NOTICE));
    assert.ok(!hidden.includes(HIDDEN_PATH_NOTICE), "a named hidden path was searched");
    const file = await run({ pattern: "absent", path: "src/main.ts" });
    assert.equal(file, "No matches found.", "an explicit file has no traversal hints");

    // Without an explicit path the root is the cwd; the glob is written
    // correctly and the hint would only be noise.
    const fromCwd = await grep.execute(
      "grep",
      { pattern: "needle", glob: "src/*.ts" },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.match(text(fromCwd), /^1 match/);
    assert.ok(!text(fromCwd).includes(SLASH_GLOB_NOTICE));

    // An empty files-mode search reports files, not matches.
    const filesOnly = await grep.execute(
      "grep",
      { pattern: "missing", output: "files" },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.match(text(filesOnly), /^No files found\./);

    const find = tools.get("find")!;
    const scopedFind = await find.execute(
      "find",
      { pattern: "src/*.ts", path: "src" },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.match(text(scopedFind), /^No files found\./);
    assert.ok(text(scopedFind).includes('try "*.ts"'));
    const hiddenFind = await find.execute(
      "find",
      { pattern: "*.md", path: ".github" },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.equal(text(hiddenFind), "No files found.");
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// Permission bits do not bind root, and Windows has no chmod 000.
const canLockDirs = process.platform !== "win32" && process.getuid?.() !== 0;

test("unreadable directories make results partial instead of failing or looking complete", {
  skip: !hasRg || !hasFd || !canLockDirs,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-unreadable-"));
  mkdirSync(path.join(root, "ok"));
  mkdirSync(path.join(root, "locked"));
  writeFileSync(path.join(root, "ok", "a.txt"), "needle\n");
  writeFileSync(path.join(root, "locked", "b.txt"), "needle\n");
  chmodSync(path.join(root, "locked"), 0o000);
  const { runtime, tools } = captureTools();
  const run = async (tool: string, params: Record<string, unknown>) => {
    const result = await tools.get(tool)!.execute(tool, params, undefined, undefined, {
      cwd: root,
    });
    return { text: text(result), details: result.details };
  };
  try {
    for (const [tool, params] of [
      ["grep", { pattern: "needle" }],
      ["grep", { pattern: "needle", output: "files" }],
      ["find", { pattern: "*.txt" }],
    ] as const) {
      const { text: output, details } = await run(tool, params);
      assert.match(output, /^Showing 1 (match in 1 file|file) \(partial results\)/, output);
      assert.match(output, /ok\/a\.txt/);
      assert.match(
        output,
        /\[Some paths could not be read \(.*locked.*\); results may be incomplete\.\]/,
      );
      assert.equal(details.unreadable, true);
    }
    // Nothing readable matched: still partial, never a bare "No matches found."
    const empty = await run("grep", { pattern: "absent" });
    assert.match(empty.text, /^Showing 0 matches in 0 files \(partial results\)/);
    // Real rg failures are still errors.
    await assert.rejects(
      tools.get("grep")!.execute("bad", { pattern: "(" }, undefined, undefined, { cwd: root }),
      /regex parse error/,
    );
  } finally {
    chmodSync(path.join(root, "locked"), 0o755);
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

test("registered grep distinguishes automatic context and files-only output", {
  skip: !hasRg,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-modes-"));
  writeFileSync(path.join(root, "a.txt"), "before\ncall(\nafter\n");
  const { runtime, tools } = captureTools();
  try {
    const tool = tools.get("grep")!;
    for (const options of [{}, { output: "files" }]) {
      const result = await tool.execute(
        "grep",
        { pattern: "call(", literal: true, ...options },
        undefined,
        undefined,
        { cwd: root },
      );
      assert.equal(result.details.resultCount, 1);
      assert.equal(result.details.fileCount, 1);
      const auto = Object.keys(options).length === 0;
      assert.equal(text(result).includes("before"), auto);
      assert.equal(text(result).includes("automatically"), auto);
      if (options.output === "files") {
        assert.equal(text(result), "1 file\n\na.txt");
        assert.match(
          tool.renderResult!(result, { expanded: false, isPartial: false }, theme, {
            isError: false,
          })
            .render(80)
            .join("\n"),
          /1 file/,
        );
      }
      for (const expanded of [false, true]) {
        const component = tool.renderResult!(result, { expanded, isPartial: false }, theme, {
          isError: false,
        });
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

test("debug logging records searches only when PI_FIND_DEBUG is set", {
  skip: !hasRg || !hasFd,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-debug-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "hit.ts"), "needle\n");
  const logFile = path.join(root, "debug.jsonl");
  const { runtime, tools } = captureTools();
  const grep = tools.get("grep")!;
  const find = tools.get("find")!;
  const events = () =>
    readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/s.jsonl" },
    model: { provider: "anthropic", id: "claude" },
  };
  try {
    // Opt-in only: unset, a disabled value, or a log path alone never writes.
    process.env.PI_FIND_DEBUG_FILE = logFile;
    for (const value of [undefined, "0", "false", ""]) {
      if (value === undefined) delete process.env.PI_FIND_DEBUG;
      else process.env.PI_FIND_DEBUG = value;
      await grep.execute("off", { pattern: "needle" }, undefined, undefined, ctx);
      assert.equal(existsSync(logFile), false, `PI_FIND_DEBUG=${value} must not log`);
    }

    process.env.PI_FIND_DEBUG = "1";
    await grep.execute("on", { pattern: "needle" }, undefined, undefined, ctx);
    const [ok] = events();
    assert.equal(ok!.v, 2);
    assert.equal(ok!.tool, "grep");
    assert.equal(ok!.outcome, "ok");
    assert.equal(ok!.toolCallId, "on");
    assert.equal(ok!.sessionId, "session-1");
    assert.equal(ok!.sessionFile, "/tmp/s.jsonl");
    assert.equal(ok!.model, "anthropic/claude");
    assert.equal(ok!.resultCount, 1);
    assert.equal(ok!.collectedCount, 1);
    assert.equal(ok!.resultLimitHit, false);
    assert.equal(ok!.outputLimitHit, false);
    assert.equal(ok!.rejectedByGlob, 0);
    assert.equal(ok!.prefilter, "*");
    assert.equal(ok!.explicitFile, false);
    assert.equal(ok!.clippedLines, 0);
    assert.equal(ok!.pathError, undefined);
    // A content search that ran to completion carries rg's own totals.
    assert.equal(ok!.searchedFiles, 1);
    assert.equal(ok!.searchedBytes, "needle\n".length);
    assert.equal(ok!.outputBytes, Buffer.byteLength("1 match in 1 file\n\nsrc/hit.ts\n1: needle"));
    assert.equal(typeof ok!.durationMs, "number");
    assert.deepEqual(ok!.params, { pattern: "needle" });

    // A slash glob written against the wrong base: every candidate is rejected.
    await grep.execute(
      "wrong-base",
      { pattern: "needle", path: "src", glob: "src/*.ts" },
      undefined,
      undefined,
      ctx,
    );
    await find.execute("find", { pattern: "src/*.ts", path: "src" }, undefined, undefined, ctx);
    const [, grepMiss, findMiss] = events();
    for (const miss of [grepMiss!, findMiss!]) {
      assert.equal(miss.resultCount, 0);
      assert.ok((miss.rejectedByGlob as number) > 0, `${miss.tool} counts glob rejections`);
      assert.equal(miss.prefilter, "*.ts");
      assert.ok((miss.notices as string[]).includes("glob_prefix"));
      assert.ok((miss.notices as string[]).includes("hidden_path"));
    }

    // Failures keep their typed tag, aborts are not errors, and both still propagate.
    await assert.rejects(
      grep.execute("err", { pattern: "needle", path: "missing" }, undefined, undefined, ctx),
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      grep.execute("abort", { pattern: "needle" }, controller.signal, undefined, ctx),
    );
    const [, , , errored, aborted] = events();
    assert.equal(errored!.outcome, "error");
    assert.equal(errored!.errorTag, "SearchInputError");
    assert.match(String(errored!.error), /does not exist/);
    assert.equal(aborted!.outcome, "aborted");
  } finally {
    delete process.env.PI_FIND_DEBUG;
    delete process.env.PI_FIND_DEBUG_FILE;
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
