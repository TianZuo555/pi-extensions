import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPattern, isSmartCaseInsensitive } from "../lib/pattern.ts";

test("a bare identifier is a literal search", () => {
  const result = classifyPattern("registerTool");
  assert.equal(result.mode, "literal");
  assert.equal(result.wildcardOnly, false);
});

test("valid regex syntax is detected as regex", () => {
  assert.equal(classifyPattern("foo|bar").mode, "regex");
  assert.equal(classifyPattern("^export const").mode, "regex");
  assert.equal(classifyPattern("on\\w+\\?:").mode, "regex");
});

test("regex-like syntax is delegated to ripgrep's parser", () => {
  // The runtime retries parser failures literally. JavaScript's parser cannot
  // determine compatibility with ripgrep's regex dialect.
  assert.equal(classifyPattern("foo(bar").mode, "regex");
  assert.equal(classifyPattern("value[0").mode, "regex");
  assert.equal(classifyPattern("a)b").mode, "regex");
  assert.equal(classifyPattern("needle(?= )").mode, "regex");
});

test("wildcard-only patterns are refused", () => {
  for (const pattern of [".*", ".", "*", ".+", "^.*$", ".*?"]) {
    assert.equal(
      classifyPattern(pattern).wildcardOnly,
      true,
      `expected ${pattern} to be refused`,
    );
  }
});

test("a real pattern containing a wildcard is not refused", () => {
  assert.equal(classifyPattern("foo.*bar").wildcardOnly, false);
  assert.equal(classifyPattern("export .*").wildcardOnly, false);
  // A literal dot-only-looking identifier is fine.
  assert.equal(classifyPattern("a.b").wildcardOnly, false);
});

test("wildcard detection ignores surrounding whitespace", () => {
  assert.equal(classifyPattern("  .*  ").wildcardOnly, true);
});

test("smart-case is insensitive only for all-lowercase patterns", () => {
  assert.equal(isSmartCaseInsensitive("registertool"), true);
  assert.equal(isSmartCaseInsensitive("registerTool"), false);
  assert.equal(isSmartCaseInsensitive("REGISTER"), false);
  // Non-letters do not make a pattern case-sensitive.
  assert.equal(isSmartCaseInsensitive("foo_bar-1"), true);
});
