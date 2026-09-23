import assert from "node:assert/strict";
import { test } from "node:test";
import { FindParams, GrepParams } from "../lib/tools.ts";
import { boundedBody, fileRows, grepRows, resultText } from "../lib/results.ts";
import {
  FIND_PARAMETER_DESCRIPTIONS,
  FIND_PROMPT_SNIPPET,
  FIND_TOOL_DESCRIPTION,
  GREP_PARAMETER_DESCRIPTIONS,
  GREP_PROMPT_SNIPPET,
  GREP_TOOL_DESCRIPTION,
  outputLimitNotice,
  oversizedRecordNotice,
  resultLimitNotice,
  searchTimeoutNotice,
} from "../lib/prompt.ts";
import type { GrepOutcome } from "../src/runtime.ts";

function outcome(matches: ReadonlyArray<[string, number, string]>): GrepOutcome {
  return {
    output: "content",
    matches: matches.map(([path, lineNumber, text]) => ({ path, lineNumber, text })),
    context: [],
    files: [...new Set(matches.map(([path]) => path))],
    truncated: false,
    timedOut: false,
    skippedRecords: 0,
  };
}

test("grep groups by file and sorts lines without repeating paths", () => {
  const result = boundedBody(
    grepRows(
      outcome([
        ["src/b.ts", 2, "const b = 2;"],
        ["src/a.ts", 8, "const c = 3;"],
        ["src/a.ts", 1, "const a = 1;"],
      ]),
    ),
  );
  assert.equal(
    result.text,
    "src/a.ts\n1: const a = 1;\n--\n8: const c = 3;\n\nsrc/b.ts\n2: const b = 2;",
  );
  assert.equal(result.resultCount, 3);
  assert.equal(result.fileCount, 2);
});

test("overlapping context is deduplicated, matches win, and only matches are counted", () => {
  const result = outcome([["a.ts", 2, "needle"]]);
  const body = boundedBody(
    grepRows({
      ...result,
      context: [
        { path: "a.ts", lineNumber: 1, text: "before" },
        { path: "a.ts", lineNumber: 1, text: "before" },
        { path: "a.ts", lineNumber: 2, text: "needle" },
        { path: "orphan.ts", lineNumber: 1, text: "not useful" },
      ],
    }),
  );
  assert.equal(body.text, "a.ts\n1- before\n2: needle");
  assert.equal(body.resultCount, 1);
  assert.equal(body.fileCount, 1);
});

test("byte truncation counts only displayed results and cannot leave an orphan heading", () => {
  const rows = grepRows(
    outcome([
      ["a.ts", 1, "needle"],
      ["b.ts", 1, "needle"],
    ]),
  );
  const body = boundedBody(rows, Buffer.byteLength(rows[0]!.text) + 3);
  assert.equal(body.resultCount, 1);
  assert.equal(body.fileCount, 1);
  assert.equal(body.truncated, true);
  assert.equal(body.text, "a.ts\n1: needle");
  assert.equal(boundedBody(rows, 1).text, "");
  const files = boundedBody(fileRows(["你好.ts", "world.ts"]), 10);
  assert.equal(files.text, "你好.ts");
  assert.equal(files.resultCount, 1);
  assert.equal(files.truncated, true);
});

test("grep exposes a small schema with a flat, Google-compatible output enum", () => {
  assert.deepEqual(Object.keys(GrepParams.properties), [
    "pattern",
    "path",
    "glob",
    "output",
    "literal",
  ]);
  assert.deepEqual(GrepParams.required, ["pattern"]);
  assert.match(JSON.stringify(GrepParams.properties.output), /"enum":\["content","files"\]/);
  assert.equal(JSON.stringify(GrepParams).includes("anyOf"), false);
});

test("find exposes exactly pattern and path", () => {
  assert.deepEqual(Object.keys(FindParams.properties), ["pattern", "path"]);
});

test("every public parameter carries a description", () => {
  for (const schema of [GrepParams, FindParams]) {
    for (const [name, property] of Object.entries(schema.properties)) {
      assert.ok(JSON.stringify(property).includes("description"), `${name} lacks description`);
    }
  }
});

test("model-facing metadata stays concise and explains defaults and budgets", () => {
  for (const value of [
    GREP_TOOL_DESCRIPTION,
    GREP_PROMPT_SNIPPET,
    FIND_TOOL_DESCRIPTION,
    FIND_PROMPT_SNIPPET,
    ...Object.values(GREP_PARAMETER_DESCRIPTIONS),
    ...Object.values(FIND_PARAMETER_DESCRIPTIONS),
  ])
    assert.ok(value.length <= 160, `metadata is too long: ${value}`);
  assert.match(GREP_TOOL_DESCRIPTION, /case-sensitive regex/);
  assert.match(GREP_TOOL_DESCRIPTION, /100 lines or 200 files/);
  for (const description of [GREP_TOOL_DESCRIPTION, FIND_TOOL_DESCRIPTION]) {
    assert.match(description, /respects \.gitignore/);
    assert.match(description, /skips hidden paths/);
  }
  assert.match(FIND_PARAMETER_DESCRIPTIONS.pattern, /relative to the search root/);
});

test("result text keeps one blank line between sections", () => {
  assert.equal(
    resultText("Showing 0 matches (partial results)", "", [searchTimeoutNotice(30_000)]),
    "Showing 0 matches (partial results)\n\n[Search timed out after 30s; results are partial. Narrow the path, pattern, or glob.]",
  );
  assert.equal(
    resultText("1 match in 1 file", "a.ts\n1: needle", []),
    "1 match in 1 file\n\na.ts\n1: needle",
  );
  assert.equal(resultText("0 files", "", []), "0 files");
});

test("limit and timeout notices say how to narrow the search", () => {
  assert.match(resultLimitNotice("matches", 100), /narrow pattern, path, or glob/);
  assert.match(outputLimitNotice("find"), /omitted files/);
  assert.match(oversizedRecordNotice(8 * 1024 * 1024), /larger than 8 MiB/);
  const notice = searchTimeoutNotice(30_000);
  assert.match(notice, /timed out after 30s/);
  assert.match(notice, /partial/);
  assert.match(notice, /narrow the path, pattern, or glob/i);
});
