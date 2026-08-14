import assert from "node:assert/strict";
import test from "node:test";
import {
  findHunkForNewLine,
  hunkNewRange,
  parseHunks,
} from "../lib/hunks.ts";

const SAMPLE_PATCH = `diff --git a/src/foo.ts b/src/foo.ts
index 123..456 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,5 @@
 line1
-line2
+line2 changed
 line3
 line4
@@ -10,3 +11,4 @@
 context
-old
+new
 tail
@@ -20,0 +23,1 @@
+added
`;

test("parseHunks returns expected hunk count and numbers", () => {
  const hunks = parseHunks(SAMPLE_PATCH);
  assert.equal(hunks.length, 3);
  assert.deepEqual(hunks[0], { oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 });
  assert.deepEqual(hunks[1], { oldStart: 10, oldLines: 3, newStart: 11, newLines: 4 });
  assert.deepEqual(hunks[2], { oldStart: 20, oldLines: 0, newStart: 23, newLines: 1 });
});

test("parseHunks treats missing comma counts as 1", () => {
  const hunks = parseHunks("@@ -1 +1 @@\n");
  assert.deepEqual(hunks[0], { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
});

test("findHunkForNewLine finds first, middle, and last lines", () => {
  const hunks = parseHunks(SAMPLE_PATCH);
  assert.equal(findHunkForNewLine(hunks, 1)?.newStart, 1);
  assert.equal(findHunkForNewLine(hunks, 3)?.newStart, 1);
  assert.equal(findHunkForNewLine(hunks, 5)?.newStart, 1);
  assert.equal(findHunkForNewLine(hunks, 12)?.newStart, 11);
  assert.equal(findHunkForNewLine(hunks, 14)?.newStart, 11);
  assert.equal(findHunkForNewLine(hunks, 23)?.newStart, 23);
});

test("findHunkForNewLine returns undefined between hunks", () => {
  const hunks = parseHunks(SAMPLE_PATCH);
  assert.equal(findHunkForNewLine(hunks, 8), undefined);
});

test("hunkNewRange handles deletion-only hunks", () => {
  const hunks = parseHunks("@@ -5,2 +12,0 @@\n");
  assert.deepEqual(hunkNewRange(hunks[0]!), [12, 12]);
});
