import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  DEBUG_EVENT_VERSION,
  MAX_DEBUG_LOG_BYTES,
  type SearchDebugEvent,
  type SearchStats,
  withSearchLog,
} from "../lib/debug.ts";
import {
  formatSummary,
  LARGE_OUTPUT_BYTES,
  nextAction,
  parseSessionTurns,
  type SessionTurns,
  staticGlobPrefix,
  summarize,
} from "../scripts/debug-stats.ts";

const stats: SearchStats = {
  resultCount: 1,
  collectedCount: 1,
  fileCount: 1,
  resultLimitHit: false,
  outputLimitHit: false,
  timedOut: false,
  skippedRecords: 0,
  rejectedByGlob: 0,
  prefilter: "*",
  outputBytes: 100,
  notices: [],
};

const call = {
  tool: "grep",
  toolCallId: "t1",
  params: { pattern: "x" },
  ctx: { cwd: "/" },
} as const;

async function withEnv(file: string, body: () => Promise<void>): Promise<void> {
  process.env.PI_FIND_DEBUG = "1";
  process.env.PI_FIND_DEBUG_FILE = file;
  try {
    await body();
  } finally {
    delete process.env.PI_FIND_DEBUG;
    delete process.env.PI_FIND_DEBUG_FILE;
  }
}

test("the log rotates once it reaches the size cap", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-rotate-"));
  const file = path.join(root, "debug.jsonl");
  try {
    writeFileSync(file, Buffer.alloc(MAX_DEBUG_LOG_BYTES));
    await withEnv(file, async () => {
      assert.equal(await withSearchLog(call, async () => ({ result: "r", stats })), "r");
    });
    assert.equal(statSync(`${file}.1`).size, MAX_DEBUG_LOG_BYTES);
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unwritable log never changes the search result or error", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-find-unwritable-"));
  const blocker = path.join(root, "not-a-dir");
  writeFileSync(blocker, "");
  try {
    await withEnv(path.join(blocker, "debug.jsonl"), async () => {
      assert.equal(await withSearchLog(call, async () => ({ result: 42, stats })), 42);
      await assert.rejects(
        withSearchLog(call, async () => {
          throw new Error("boom");
        }),
        /boom/,
      );
    });
    assert.equal(existsSync(path.join(blocker, "debug.jsonl")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function toolCallLine(calls: ReadonlyArray<[string, string, Record<string, unknown>]>): string {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "..." },
        ...calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })),
      ],
    },
  });
}

test("next action skips parallel siblings and classifies the following turn", () => {
  const turns = parseSessionTurns(
    [
      JSON.stringify({ type: "session", id: "s" }),
      toolCallLine([
        ["g1", "grep", { pattern: "a" }],
        ["g1-sibling", "read", { path: "x" }],
      ]),
      JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "g1" } }),
      toolCallLine([["b1", "bash", { command: "cd src && rg -n needle" }]]),
      toolCallLine([["g2", "grep", { pattern: "b" }]]),
      toolCallLine([["r1", "read", { path: "a.ts" }]]),
      "{torn",
    ].join("\n"),
  );
  assert.equal(nextAction(turns, "g1"), "shell_search");
  assert.equal(nextAction(turns, "b1"), "retry");
  assert.equal(nextAction(turns, "g2"), "read");
  assert.equal(nextAction(turns, "r1"), "none");
  assert.equal(nextAction(turns, "missing"), "unknown");
  assert.equal(nextAction(undefined, "g1"), "unknown");
  const other = parseSessionTurns(
    [toolCallLine([["f", "find", {}]]), toolCallLine([["b", "bash", { command: "ls" }]])].join(
      "\n",
    ),
  );
  assert.equal(nextAction(other, "f"), "other");
});

function event(overrides: Partial<SearchDebugEvent>): SearchDebugEvent {
  return {
    v: DEBUG_EVENT_VERSION,
    ts: "2026-09-23T00:00:00.000Z",
    tool: "grep",
    cwd: "/repo",
    toolCallId: "t",
    params: { pattern: "x" },
    durationMs: 10,
    outcome: "ok",
    ...stats,
    ...overrides,
  };
}

test("summary separates empty, partial, and failed searches and joins next actions", () => {
  const turns: SessionTurns = [
    [{ id: "empty", name: "grep", arguments: {} }],
    [{ id: "shell", name: "bash", arguments: { command: "grep -r x ." } }],
  ];
  const summary = summarize(
    [
      event({ toolCallId: "hit" }),
      event({
        toolCallId: "empty",
        sessionFile: "/s.jsonl",
        resultCount: 0,
        rejectedByGlob: 3,
        prefilter: "*.ts",
        params: { pattern: "x", path: "src", glob: "src/*.ts" },
        notices: ["file_size_limit", "hidden_path", "slash_glob"],
      }),
      event({ toolCallId: "cap", resultLimitHit: true, outputLimitHit: true, durationMs: 90 }),
      event({ toolCallId: "err", outcome: "error", errorTag: "SearchProcessError" }),
      event({ toolCallId: "stop", outcome: "aborted" }),
      event({ tool: "find", toolCallId: "f", resultCount: 0 }),
      { ...event({}), v: 1 },
    ],
    (file) => (file === "/s.jsonl" ? turns : undefined),
  );
  assert.equal(summary.events, 6);
  assert.equal(summary.ignored, 1);
  const grep = summary.tools.grep!;
  assert.equal(grep.calls, 5);
  assert.deepEqual(grep.outcomes, { ok: 3, error: 1, aborted: 1 });
  assert.equal(grep.emptyComplete, 1);
  assert.equal(grep.emptyWithGlobRejections, 1);
  assert.equal(grep.partial, 1);
  assert.deepEqual(grep.partialReasons, { result_limit: 1, output_limit: 1 });
  assert.equal(grep.broadScans, 2);
  assert.deepEqual(grep.notices, { file_size_limit: 1, hidden_path: 1, slash_glob: 1 });
  assert.deepEqual(grep.errorTags, { SearchProcessError: 1 });
  assert.deepEqual(grep.nextAfterEmpty, { shell_search: 1 });
  assert.equal(grep.examples.emptyThenShell.length, 1);
  assert.deepEqual(grep.nextAfterPartial, { unknown: 1 });
  assert.deepEqual(grep.nextAfterError, { unknown: 1 });
  assert.equal(grep.durationMs.p95, 90);
  assert.equal(summary.tools.find!.emptyComplete, 1);
  const text = formatSummary(summary);
  assert.match(text, /6 events/);
  assert.match(text, /with glob rejections\s+1/);
  assert.match(text, /e\.g\. empty, glob rejected: .*src\/\*\.ts/);
});

test("fixed glob prefixes are the directories rg/fd could start from", () => {
  assert.equal(staticGlobPrefix("packages/web/**/*.tsx"), "packages/web");
  assert.equal(staticGlobPrefix("./src/*.ts"), "src");
  assert.equal(staticGlobPrefix(".github/**/*.yml"), ".github");
  assert.equal(staticGlobPrefix("src/{a,b}/*.ts"), "src");
  for (const glob of [undefined, "*.ts", "**/*.ts", "{src,lib}/*.ts", "!src/**/*.ts"])
    assert.equal(staticGlobPrefix(glob), undefined, String(glob));
});

test("summary measures fixed-prefix scans and output cost for the open ADR follow-ups", () => {
  const summary = summarize(
    [
      event({
        tool: "find",
        params: { pattern: "packages/web/**/*.tsx" },
        durationMs: 900,
        rejectedByGlob: 4000,
      }),
      event({ tool: "find", params: { pattern: ".github/**/*.yml" }, resultCount: 0 }),
      event({ tool: "find", params: { pattern: "*.yml", path: ".github" }, durationMs: 5 }),
      event({
        params: { pattern: "x", glob: "src/**/*.ts" },
        timedOut: true,
        searchedFiles: undefined,
      }),
      event({ params: { pattern: "x" }, searchedFiles: 40, outputBytes: 200 }),
      event({
        toolCallId: "big",
        sessionFile: "/s.jsonl",
        params: { pattern: "y" },
        outputBytes: LARGE_OUTPUT_BYTES + 1,
        outputLimitHit: true,
        clippedLines: 3,
      }),
    ],
    () => [
      [{ id: "big", name: "grep", arguments: {} }],
      [{ id: "next", name: "read", arguments: {} }],
    ],
  );
  const find = summary.tools.find!.narrowable;
  assert.equal(find.calls, 2);
  assert.equal(find.durationMs.max, 900);
  assert.equal(find.otherDurationMs.max, 5);
  assert.equal(find.rejectedByGlob.max, 4000);
  assert.equal(find.hiddenPrefixEmpty, 1);
  const grep = summary.tools.grep!;
  assert.equal(grep.narrowable.calls, 1);
  assert.equal(grep.narrowable.timeouts, 1);
  assert.equal(grep.narrowable.otherSearchedFiles.max, 40);
  assert.equal(grep.output.large, 1);
  assert.equal(grep.output.outputLimitHit, 1);
  assert.equal(grep.output.withClippedLines, 1);
  assert.deepEqual(grep.output.nextAfterLarge, { read: 1 });
  assert.equal(grep.output.bytes.max, LARGE_OUTPUT_BYTES + 1);
  const text = formatSummary(summary);
  assert.match(text, /\[A\] globs with a fixed dir prefix: 2/);
  assert.match(text, /\[B\] output bytes/);
});
