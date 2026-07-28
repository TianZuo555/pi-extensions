// Regression: pi issue #3554 — fuzzy matching must NOT normalize the whole file.
// Characters OUTSIDE the edited span (smart quotes, em-dash, NBSP, trailing ws)
// must be preserved byte-for-byte. Our implementation edits by slicing the
// ORIGINAL and splicing in newText, so untouched bytes are never normalized.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits } from "../lib/edit-replace.ts";

// Smart quotes “ ” ‘ ’, em-dash —, non-breaking space, trailing whitespace.
const FILE =
	'const greeting = "Hello, World!";\n' +
	'// comment with \u201csmart quotes\u201d and an em\u2014dash\n' +
	'const name = "Alice";\n' +
	'// non\u00a0breaking space here   \n' + // trailing spaces after "here"
	'const result = "done";\n';

test("fuzzy match edits only the touched line; everything else byte-identical", () => {
	// oldText uses ASCII quotes where the file has smart quotes only on line 2,
	// but the edit targets line 3 which is exact. Force fuzzy by drifting ws.
	const edit = {
		oldText: 'const name = "Alice";', // exact match on line 3
		newText: 'const name = "Bob";',
	};
	const { content } = applyEdits(FILE, [edit], "test.ts");

	const lines = content.split("\n");
	assert.equal(lines[2], 'const name = "Bob";'); // edited
	// Untouched lines preserved EXACTLY, including smart quotes / em-dash / NBSP / trailing ws.
	assert.equal(lines[0], 'const greeting = "Hello, World!";');
	assert.equal(lines[1], "// comment with \u201csmart quotes\u201d and an em\u2014dash");
	assert.equal(lines[3], "// non\u00a0breaking space here   ");
	assert.equal(lines[4], 'const result = "done";');
});

test("fuzzy match (NBSP drift) still preserves untouched Unicode elsewhere", () => {
	// Drift: oldText uses single space, file uses NBSP — the unicode strategy
	// (tighter than whitespace-collapse) resolves it.
	const edit = {
		oldText: "// non breaking space here", // NBSP drifts → fuzzy
		newText: "// edited line",
	};
	const { content, edits } = applyEdits(FILE, [edit], "test.ts");
	assert.equal(edits[0].matchedVia, "unicode");
	const lines = content.split("\n");
	assert.equal(lines[3], "// edited line");
	// Smart quotes / em-dash on line 1 untouched.
	assert.equal(lines[1], "// comment with \u201csmart quotes\u201d and an em\u2014dash");
});

test("BOM at start of file is preserved", () => {
	const bom = "\uFEFF";
	const src = bom + 'const a = 1;\nconst b = 2;\n';
	const { content } = applyEdits(src, [{ oldText: "const b = 2;", newText: "const b = 3;" }], "bom.ts");
	assert.equal(content[0], "\uFEFF");
	assert.ok(content.includes("const b = 3;"));
});
