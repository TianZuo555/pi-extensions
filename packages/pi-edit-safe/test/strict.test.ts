// Regression: ambiguity must throw, never silently pick the wrong occurrence.
// This is the opencode issue #1261 / #32559 class of bug — the tui.go case where
// multiple `}\n\n    return ...` blocks existed and the wrong one got edited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits } from "../lib/edit-replace.ts";

const FILE = `package main

func layoutA() {
	prepare()
	return layoutA
}

func layoutB() {
	prepare()
	return layoutB
}

func layoutC() {
	prepare()
	return layoutC
}
`;

test("ambiguous oldText that is not unique → throws (not silently edits first)", () => {
  // `prepare()` appears 3 times — not unique.
  assert.throws(
    () => applyEdits(FILE, [{ oldText: "\tprepare()", newText: "\tprepare(true)" }], "tui.go"),
    /not unique/i,
  );
});

test("overlapping exact occurrences are counted as ambiguous → throws", () => {
  // "aa" occurs at positions 0 AND 1 of "aaa"; picking either silently would
  // be a wrong-place edit. Overlap-aware counting must see 2 occurrences.
  assert.throws(
    () => applyEdits("aaa\n", [{ oldText: "aa", newText: "XY" }], "overlap.txt"),
    /not unique/i,
  );
});

test("fuzzy no-op (file already matches newText) → throws instead of silent write", () => {
  // oldText drifts (double space) so it fuzzy-matches the line, but newText
  // equals what the file already contains → stale context, fail loudly.
  const src = "alpha  beta\n";
  assert.throws(
    () => applyEdits(src, [{ oldText: "alpha beta", newText: "alpha  beta" }], "noop.txt"),
    /no changes|already matches/i,
  );
});

test("same oldText twice (different newText): second fails with earlier-edit hint", () => {
  // Sequential: edit 1 rewrites the line, so edit 2's oldText no longer exists.
  // The error must say an earlier edit caused it, not just "not found".
  assert.throws(
    () =>
      applyEdits(
        FILE,
        [
          { oldText: "func layoutA() {", newText: "func layoutA(x int) {" },
          { oldText: "func layoutA() {", newText: "func layoutA(y int) {" },
        ],
        "tui.go",
      ),
    /earlier edit/i,
  );
});

test("edit targeting text consumed by an earlier edit → fails with earlier-edit hint", () => {
  assert.throws(
    () =>
      applyEdits(
        "function f() {\n  return 1;\n}\n",
        [
          { oldText: "function f() {\n  return 1;\n}", newText: "x" },
          { oldText: "return 1;", newText: "return 2;" },
        ],
        "f.js",
      ),
    /earlier edit/i,
  );
});

test("exact duplicate edit entries → throws duplicate (never applied twice)", () => {
  assert.throws(
    () =>
      applyEdits(
        FILE,
        [
          { oldText: "func layoutA() {", newText: "func layoutA(ctx) {" },
          { oldText: "func layoutA() {", newText: "func layoutA(ctx) {" },
        ],
        "tui.go",
      ),
    /duplicate/i,
  );
});

test("sequential chaining: a later edit may target an earlier edit's output", () => {
  const src = "const value = 1;\nconst other = 9;\n";
  const { content, edits } = applyEdits(
    src,
    [
      { oldText: "const value = 1;", newText: "const value = 2;" },
      { oldText: "const value = 2;", newText: "export const value = 2;" },
    ],
    "chain.ts",
  );
  assert.equal(content, "export const value = 2;\nconst other = 9;\n");
  assert.equal(edits.length, 2);
});

test("disjoint multi-edit behaves as if matched against the original file", () => {
  const src = "import a from 'a';\nimport b from 'b';\nimport c from 'c';\n";
  const { content } = applyEdits(
    src,
    [
      { oldText: "import c from 'c';", newText: "import c from 'z';" },
      { oldText: "import a from 'a';", newText: "import a from 'x';" },
    ],
    "imports.ts",
  );
  assert.equal(content, "import a from 'x';\nimport b from 'b';\nimport c from 'z';\n");
});

test("earlier edit's newText creates extra matches for a later edit → ambiguity hint", () => {
  const src = "start()\nmarker()\nend()\n";
  assert.throws(
    () =>
      applyEdits(
        src,
        [
          { oldText: "start()", newText: "start()\nmarker()" },
          { oldText: "marker()", newText: "marker(1)" },
        ],
        "seq.ts",
      ),
    /introduced additional matches/i,
  );
});

test("unique oldText edits cleanly, returns line metadata", () => {
  const { content, edits } = applyEdits(
    FILE,
    [{ oldText: "func layoutA() {", newText: "func layoutA(ctx) {" }],
    "tui.go",
  );
  assert.equal(edits[0].matchedVia, "exact");
  assert.equal(edits[0].startLine, 3);
  assert.ok(content.includes("func layoutA(ctx) {"));
  assert.ok(content.includes("func layoutB() {")); // untouched
});
