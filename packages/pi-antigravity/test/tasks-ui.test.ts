import assert from "node:assert/strict";
import { test } from "node:test";
import { agyTaskLogLines } from "../src/tasks-ui.ts";

test("agyTaskLogLines strips terminal escape sequences", () => {
  assert.deepEqual(agyTaskLogLines("[31mred[0m plain"), ["red plain"]);
});

test("agyTaskLogLines expands tabs and drops control chars", () => {
  assert.deepEqual(agyTaskLogLines("a\tbc"), ["a    bc"]);
});

test("agyTaskLogLines drops trailing blank lines", () => {
  assert.deepEqual(agyTaskLogLines("one\n\n\n"), ["one"]);
});

test("agyTaskLogLines falls back to (no output) for empty logs", () => {
  assert.deepEqual(agyTaskLogLines(""), ["(no output)"]);
  assert.deepEqual(agyTaskLogLines("\n\n"), ["(no output)"]);
});
