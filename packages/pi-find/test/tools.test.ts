import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FindParams,
  GrepParams,
  renderGrepLines,
} from "../lib/tools.ts";
import {
  clampParam,
  FIND_PARAMETER_DESCRIPTIONS,
  FIND_PROMPT_SNIPPET,
  FIND_TOOL_DESCRIPTION,
  GREP_PARAMETER_DESCRIPTIONS,
  GREP_PROMPT_SNIPPET,
  GREP_TOOL_DESCRIPTION,
  tooManyResultsNotice,
} from "../lib/prompt.ts";
import type { GrepOutcome } from "../src/runtime.ts";

function outcome(
  matches: ReadonlyArray<[string, number, string, boolean]>,
): GrepOutcome {
  return {
    matches: matches.map(([p, lineNumber, text, isMatch]) => ({
      path: p,
      lineNumber,
      text,
      isMatch,
    })),
    truncated: false,
    searchRoot: "/tmp",
    hasConstraints: false,
  };
}

test("renders matches grouped under their file", () => {
  const lines = renderGrepLines(
    outcome([
      ["src/a.ts", 1, "const x = 1;", true],
      ["src/a.ts", 9, "const y = 2;", true],
    ]),
  );
  assert.deepEqual(lines, [
    "src/a.ts",
    "    1: const x = 1;",
    "    9: const y = 2;",
  ]);
});

test("separates files with a blank line", () => {
  const lines = renderGrepLines(
    outcome([
      ["src/a.ts", 1, "a", true],
      ["src/b.ts", 2, "b", true],
    ]),
  );
  assert.deepEqual(lines, ["src/a.ts", "    1: a", "", "src/b.ts", "    2: b"]);
});

test("marks context lines with a dash, matches with a colon", () => {
  // Mirrors ripgrep's own convention, which models already read fluently.
  const lines = renderGrepLines(
    outcome([
      ["src/a.ts", 1, "before", false],
      ["src/a.ts", 2, "hit", true],
      ["src/a.ts", 3, "after", false],
    ]),
  );
  assert.deepEqual(lines, [
    "src/a.ts",
    "    1- before",
    "    2: hit",
    "    3- after",
  ]);
});

test("renders an empty outcome as no lines", () => {
  assert.deepEqual(renderGrepLines(outcome([])), []);
});

test("the overflow notice shows shown, total, and remaining count", () => {
  const notice = tooManyResultsNotice(20, 57, "grep");
  assert.match(notice, /Showing 20 of 57/);
  assert.match(notice, /37 more lines omitted/);
  assert.match(notice, /Narrow the search with path\/exclude/);
  assert.match(notice, /reduce context/);
  assert.match(notice, /raising limit does not reveal omitted lines/);
});

test("the overflow notice uses a singular for one remaining line", () => {
  assert.match(tooManyResultsNotice(20, 21, "find"), /1 more path omitted/);
  assert.doesNotMatch(tooManyResultsNotice(20, 21, "find"), /reduce context/);
});

test("grep exposes pattern (string or array), path, exclude, and limit parameters", () => {
  const keys = Object.keys(GrepParams.properties);
  for (const key of [
    "pattern",
    "path",
    "exclude",
    "caseSensitive",
    "context",
    "limit",
  ]) {
    assert.ok(keys.includes(key), `grep is missing ${key}`);
  }
  assert.ok(!keys.includes("cursor"), "grep should not have cursor");
});

test("grep pattern accepts a string or an array of non-empty strings with bounds", () => {
  const property = GrepParams.properties.pattern;
  assert.ok(property, "missing pattern");
  const json = JSON.stringify(property);
  assert.equal(json.includes("anyOf"), true, "pattern should accept a union");
  assert.match(json, /"minLength":\s*1/);
  assert.match(json, /"maxItems":\s*64/);
});

test("path and exclude accept a string or an array", () => {
  for (const schema of [GrepParams, FindParams]) {
    for (const field of ["path", "exclude"] as const) {
      const property = schema.properties[field];
      assert.ok(property, `missing ${field}`);
      assert.equal(
        JSON.stringify(property).includes("anyOf"),
        true,
        `${field} should accept a union`,
      );
    }
  }
});

test("every parameter carries a description", () => {
  for (const schema of [GrepParams, FindParams]) {
    for (const [name, property] of Object.entries(schema.properties)) {
      const described = JSON.stringify(property).includes("description");
      assert.ok(described, `${name} has no description`);
    }
  }
});

test("model-facing search metadata stays concise", () => {
  const tools = [
    {
      name: "grep",
      schema: GrepParams,
      description: GREP_TOOL_DESCRIPTION,
      snippet: GREP_PROMPT_SNIPPET,
      schemaBudget: 900,
    },
    {
      name: "find",
      schema: FindParams,
      description: FIND_TOOL_DESCRIPTION,
      snippet: FIND_PROMPT_SNIPPET,
      schemaBudget: 600,
    },
  ];

  for (const tool of tools) {
    const schemaLength = JSON.stringify(tool.schema).length;
    assert.ok(
      schemaLength <= tool.schemaBudget,
      `${tool.name} schema budget exceeded: ${schemaLength} chars`,
    );
    assert.ok(tool.description.length <= 80, `${tool.name} description is too long`);
    assert.ok(tool.snippet.length <= 24, `${tool.name} snippet is too long`);
  }
});

test("numeric caps live in descriptions; runtime clamps instead of the schema", () => {
  // The schema must not reject out-of-range integers with a validation
  // error; execute() clamps them and appends a notice instead.
  for (const schema of [GrepParams, FindParams]) {
    assert.doesNotMatch(
      JSON.stringify(schema.properties.limit),
      /"maximum"/,
      "limit schema should stay lenient",
    );
  }
  assert.doesNotMatch(
    JSON.stringify(GrepParams.properties.context),
    /"maximum"/,
    "context schema should stay lenient",
  );
  // With the bounds gone from the schema, descriptions are the only place
  // that advertises them.
  assert.match(GREP_PARAMETER_DESCRIPTIONS.context, /at most 20\./);
  assert.match(GREP_PARAMETER_DESCRIPTIONS.limit, /at most 1000\./);
  assert.match(FIND_PARAMETER_DESCRIPTIONS.limit, /at most 1000\./);
});

test("clampParam clamps out-of-range values and explains the substitution", () => {
  const inRange = clampParam("limit", 50, 1, 1000);
  assert.equal(inRange.value, 50);
  assert.equal(inRange.notice, "");

  const tooHigh = clampParam("context", 45, 0, 20);
  assert.equal(tooHigh.value, 20);
  assert.match(
    tooHigh.notice,
    /context=45 is outside 0–20; ran with context=20/,
  );

  const tooLow = clampParam("context", -3, 0, 20);
  assert.equal(tooLow.value, 0);
  assert.match(tooLow.notice, /ran with context=0/);
});
