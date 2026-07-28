// Fuzzy strategies land correctly and write newText verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits } from "../lib/edit-replace.ts";

test("line-trimmed: indentation drift is tolerated, span is the ORIGINAL lines", () => {
	const src = "function f() {\n    return 1;\n}\n";
	// oldText uses 2-space indent; file uses 4-space → exact fails, line-trimmed matches.
	const edit = { oldText: "function f() {\n  return 1;\n}", newText: "function f() {\n    return 2;\n}" };
	const { content, edits } = applyEdits(src, [edit], "f.js");
	assert.equal(edits[0].matchedVia, "line-trimmed");
	assert.equal(content, "function f() {\n    return 2;\n}\n");
});

test("whitespace-normalized: collapsed-ws drift tolerated", () => {
	const src = "const x =    a   +   b;\n";
	// oldText single-spaces everything; file has multiple spaces → whitespace strategy.
	const edit = { oldText: "const x = a + b;", newText: "const x = a - b;" };
	const { content, edits } = applyEdits(src, [edit], "x.js");
	assert.equal(edits[0].matchedVia, "whitespace");
	assert.equal(content, "const x = a - b;\n");
});

test("escape-normalized: literal \\n matches actual newline", () => {
	const src = "const msg = hello world;\n";
	// oldText writes a literal backslash-n where the file has a space; escape strategy
	// won't help here. Instead test: file has actual newline, oldText writes \\n.
	const multi = "line one\nline two\n";
	const edit = { oldText: "line one\\nline two", newText: "alpha\\nbeta" };
	const { content, edits } = applyEdits(multi, [edit], "esc.txt");
	assert.equal(edits[0].matchedVia, "escape");
	// newText written verbatim (literal backslash-n preserved).
	assert.equal(content, "alpha\\nbeta\n");
});

test("newText with $& regex special chars is written literally (no String.replace expansion)", () => {
	const src = "price = 100;\n";
	const edit = { oldText: "price = 100;", newText: "price = $& discount;" };
	const { content } = applyEdits(src, [edit], "p.js");
	// $& must remain literal, NOT expand to the matched text.
	assert.equal(content, "price = $& discount;\n");
});

test("CRLF source: newText line endings converted to match file", () => {
	const src = "const a = 1;\r\nconst b = 2;\r\n";
	const edit = { oldText: "const b = 2;", newText: "const b = 3;\nconst c = 4;" };
	const { content } = applyEdits(src, [edit], "crlf.js");
	// newText's LF should be normalized to CRLF.
	assert.equal(content, "const a = 1;\r\nconst b = 3;\r\nconst c = 4;\r\n");
});

test("too-short oldText with no exact match refuses fuzzy", () => {
	const src = "aaa bbb ccc\n";
	// "xy" is shorter than MIN_FUZZY (5) and not an exact match → throws.
	assert.throws(
		() => applyEdits(src, [{ oldText: "xy", newText: "q" }], "short.txt"),
		/too short/i,
	);
});

// --- line-ending safety at the span boundary ---

test("CRLF + line-trimmed fuzzy: the pair's \\r stays with the file (no bare-\\n corruption)", () => {
	const src = "function f() {\r\n    return 1;\r\n}\r\nconst x = 1;\r\n";
	// oldText uses 2-space indent and LF → exact fails, line-trimmed matches.
	const edit = { oldText: "function f() {\n  return 1;\n}", newText: "function f() {\n    return 2;\n}" };
	const { content, edits } = applyEdits(src, [edit], "crlf.js");
	assert.equal(edits[0].matchedVia, "line-trimmed");
	assert.equal(content, "function f() {\r\n    return 2;\r\n}\r\nconst x = 1;\r\n");
});

test("CRLF + whitespace fuzzy single line: terminator intact", () => {
	const src = "const x =    a   +   b;\r\nconst y = 2;\r\n";
	const edit = { oldText: "const x = a + b;", newText: "const x = a - b;" };
	const { content } = applyEdits(src, [edit], "crlf2.js");
	assert.equal(content, "const x = a - b;\r\nconst y = 2;\r\n");
});

test("LF file: stray CRLF in newText is normalized to LF", () => {
	const src = "const a = 1;\nconst b = 2;\n";
	const edit = { oldText: "const b = 2;", newText: "const b = 3;\r\nconst c = 4;" };
	const { content } = applyEdits(src, [edit], "lf.js");
	assert.equal(content, "const a = 1;\nconst b = 3;\nconst c = 4;\n");
});

test("mixed-endings file: newText verbatim, untouched terminators preserved", () => {
	const src = "a = 1;\r\nb = 2;\nc = 3;\r\n";
	const edit = { oldText: "c = 3;", newText: "c = 30;\nc2 = 31;" };
	const { content } = applyEdits(src, [edit], "mixed.js");
	// Line 1 keeps \r\n, line 2 keeps bare \n, newText's internal \n stays LF.
	assert.equal(content, "a = 1;\r\nb = 2;\nc = 30;\nc2 = 31;\r\n");
});

// --- whitespace strategy: trailing-newline oldText ---

test("whitespace: trailing-newline oldText must not absorb a whitespace-only next line", () => {
	const src = "alpha  beta\n   \nrest\n";
	const edit = { oldText: "alpha beta\n", newText: "ALPHA_BETA\n" };
	const { content, edits } = applyEdits(src, [edit], "ws.txt");
	assert.equal(edits[0].matchedVia, "whitespace");
	// The 3 spaces on line 2 are outside the edit and must survive.
	assert.equal(content, "ALPHA_BETA\n   \nrest\n");
});

test("whitespace: trailing-newline oldText matches when the next line has content", () => {
	const src = "alpha  beta\nrest\n";
	const edit = { oldText: "alpha beta\n", newText: "ALPHA_BETA\n" };
	const { content } = applyEdits(src, [edit], "ws2.txt");
	assert.equal(content, "ALPHA_BETA\nrest\n");
});

// --- escape strategy ---

test("escape: multi-line unescape (4 lines) is not flagged disproportionate", () => {
	const src = "header\nalpha\nbeta\ngamma\ndelta\nfooter\n";
	// oldText is ONE physical line with literal \n escapes → unescapes to 4 lines.
	const edit = { oldText: "alpha\\nbeta\\ngamma\\ndelta", newText: "REPLACED" };
	const { content, edits } = applyEdits(src, [edit], "esc4.txt");
	assert.equal(edits[0].matchedVia, "escape");
	assert.equal(content, "header\nREPLACED\nfooter\n");
});

test("escape: literal \\n oldText matches across CRLF line endings", () => {
	const src = "line one\r\nline two\r\nrest\r\n";
	const edit = { oldText: "line one\\nline two", newText: "merged" };
	const { content, edits } = applyEdits(src, [edit], "esc-crlf.txt");
	assert.equal(edits[0].matchedVia, "escape");
	assert.equal(content, "merged\r\nrest\r\n");
});

// --- unicode punctuation strategy ---

test("unicode: ASCII oldText matches smart-quote/em-dash line; newText verbatim; others untouched", () => {
	const src = "Use \u201csmart quotes\u201d \u2014 always.\nSecond\u00a0line stays.\n";
	const edit = { oldText: 'Use "smart quotes" - always.', newText: 'Use "plain quotes" - rarely.' };
	const { content, edits } = applyEdits(src, [edit], "u.md");
	assert.equal(edits[0].matchedVia, "unicode");
	const lines = content.split("\n");
	assert.equal(lines[0], 'Use "plain quotes" - rarely.'); // verbatim ASCII newText
	assert.equal(lines[1], "Second\u00a0line stays."); // NBSP outside the span untouched
});

test("unicode: two lines that normalize identically → ambiguous, throws", () => {
	const src = "\u201cvalue\u201d \u2014 keep\n\u201cvalue\u201d \u2014 keep\n";
	assert.throws(
		() => applyEdits(src, [{ oldText: '"value" - keep', newText: '"value" - drop' }], "dup.md"),
		/more than once|candidates/i,
	);
});
