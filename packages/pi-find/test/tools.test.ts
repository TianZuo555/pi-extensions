import assert from "node:assert/strict";
import { test } from "node:test";
import { FindParams, GrepParams, renderGrepLines } from "../lib/tools.ts";
import {
  FIND_PARAMETER_DESCRIPTIONS,
  FIND_PROMPT_SNIPPET,
  FIND_TOOL_DESCRIPTION,
  GREP_PARAMETER_DESCRIPTIONS,
  GREP_PROMPT_SNIPPET,
  GREP_TOOL_DESCRIPTION,
  outputLimitNotice,
  resultLimitNotice,
} from "../lib/prompt.ts";
import type { GrepOutcome } from "../src/runtime.ts";

function outcome(matches: ReadonlyArray<[string, number, string]>): GrepOutcome {
  return {
    matches: matches.map(([path, lineNumber, text]) => ({ path, lineNumber, text })),
    truncated: false,
  };
}

test("grep renders one conventional path:line:text row per match", () => {
  assert.deepEqual(
    renderGrepLines(outcome([
      ["src/a.ts", 1, "const a = 1;"],
      ["src/b.ts", 2, "const b = 2;"],
    ])),
    ["src/a.ts:1: const a = 1;", "src/b.ts:2: const b = 2;"],
  );
});

test("grep exposes exactly pattern, path, and glob", () => {
  assert.deepEqual(Object.keys(GrepParams.properties), ["pattern", "path", "glob"]);
  assert.equal(JSON.stringify(GrepParams.properties.pattern).includes("anyOf"), false);
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

test("model-facing metadata stays concise and describes the fixed semantics", () => {
  for (const value of [
    GREP_TOOL_DESCRIPTION,
    GREP_PROMPT_SNIPPET,
    FIND_TOOL_DESCRIPTION,
    FIND_PROMPT_SNIPPET,
    ...Object.values(GREP_PARAMETER_DESCRIPTIONS),
    ...Object.values(FIND_PARAMETER_DESCRIPTIONS),
  ]) {
    assert.ok(value.length <= 90, `metadata is too long: ${value}`);
  }
  assert.match(GREP_TOOL_DESCRIPTION, /case-sensitive regex/);
  assert.match(FIND_TOOL_DESCRIPTION, /glob/);
});

test("fixed limit notices tell the caller to narrow the search", () => {
  assert.match(resultLimitNotice("matches", 100), /narrow pattern, path, or glob/);
  assert.match(outputLimitNotice("find"), /omitted files/);
});
