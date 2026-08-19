import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FindParams,
  GrepParams,
  renderGrepLines,
} from "../lib/tools.ts";
import {
  FIND_PARAMETER_DESCRIPTIONS,
  FIND_PROMPT_GUIDELINES,
  GREP_PARAMETER_DESCRIPTIONS,
  GREP_PROMPT_GUIDELINES,
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
  assert.match(tooManyResultsNotice(20, 21, "find"), /1 more line omitted/);
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

test("prompt guidelines stay within their system-prompt budget", () => {
  // Guidelines are merged flat into every request's system prompt, so the
  // property worth defending is that they stay few and short, not that they
  // exist: pi's built-in grep/find ship with none at all.
  for (const guidelines of [
    GREP_PROMPT_GUIDELINES,
    FIND_PROMPT_GUIDELINES,
  ]) {
    assert.ok(guidelines.length <= 2, "too many guideline lines");
    const budget = guidelines.reduce((total, line) => total + line.length, 0);
    assert.ok(budget <= 260, `guideline budget exceeded: ${budget} chars`);
    for (const line of guidelines) {
      assert.ok(line.length > 0);
      assert.match(line, /^(grep|find):/);
    }
  }
});

test("descriptions do not restate bounds the schema already carries", () => {
  for (const descriptions of [
    GREP_PARAMETER_DESCRIPTIONS,
    FIND_PARAMETER_DESCRIPTIONS,
  ]) {
    for (const [name, text] of Object.entries(descriptions)) {
      assert.doesNotMatch(text, /maximum \d/i, `${name} restates a schema bound`);
    }
  }
});
