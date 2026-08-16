import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FindParams,
  GrepParams,
  MultiGrepParams,
  renderGrepLines,
} from "../lib/tools.ts";
import {
  FIND_PROMPT_GUIDELINES,
  GREP_PROMPT_GUIDELINES,
  MULTI_GREP_PROMPT_GUIDELINES,
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

test("the overflow notice names the cursor and the remaining count", () => {
  const notice = tooManyResultsNotice(20, 57, "grep_c1");
  assert.match(notice, /Showing 20 of 57/);
  assert.match(notice, /37 more lines/);
  assert.match(notice, /cursor="grep_c1"/);
  assert.match(notice, /same required query field/);
});

test("the overflow notice uses a singular for one remaining line", () => {
  assert.match(tooManyResultsNotice(20, 21, "grep_c2"), /1 more line available/);
});

test("grep exposes path, exclude, and pagination parameters", () => {
  const keys = Object.keys(GrepParams.properties);
  for (const key of [
    "pattern",
    "path",
    "exclude",
    "caseSensitive",
    "context",
    "limit",
    "cursor",
  ]) {
    assert.ok(keys.includes(key), `grep is missing ${key}`);
  }
});

test("path and exclude accept a string or an array", () => {
  // The model writes either shape; rejecting one would be a silent failure.
  for (const schema of [GrepParams, FindParams, MultiGrepParams]) {
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

test("multi_grep requires at least one pattern", () => {
  // minItems lives in the emitted schema rather than the static TypeBox type.
  const patterns = JSON.stringify(MultiGrepParams.properties.patterns);
  assert.match(patterns, /"minItems":\s*1/);
});

test("every parameter carries a description", () => {
  for (const schema of [GrepParams, FindParams, MultiGrepParams]) {
    for (const [name, property] of Object.entries(schema.properties)) {
      const described = JSON.stringify(property).includes("description");
      assert.ok(described, `${name} has no description`);
    }
  }
});

test("each tool contributes prompt guidelines", () => {
  // pi ships its built-in grep/find with none; these are the whole point.
  for (const guidelines of [
    GREP_PROMPT_GUIDELINES,
    FIND_PROMPT_GUIDELINES,
    MULTI_GREP_PROMPT_GUIDELINES,
  ]) {
    assert.ok(guidelines.length >= 3);
    for (const line of guidelines) {
      assert.ok(line.length > 0);
      // Guidelines are merged flat into the system prompt, so each has to name
      // the tool it constrains.
      assert.match(line, /^(grep|find|multi_grep):/);
    }
  }
});
