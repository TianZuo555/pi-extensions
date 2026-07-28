// Edge cases: binary files, disproportionate fuzzy spans, empty/identical edits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, isDisproportionate } from "../lib/edit-replace.ts";

test("binary file (NUL byte): fuzzy refused, only exact allowed", () => {
	const src = "header\n\x00\x01\x02 binary data \x00\ntrailer\n";
	// Exact match on a unique ascii snippet still works.
	const exact = applyEdits(src, [{ oldText: "trailer", newText: "footer" }], "bin.dat");
	assert.ok(exact.content.includes("footer"));

	// Fuzzy on a binary file → throws even if the text is "long enough".
	assert.throws(
		() =>
			applyEdits(
				src,
				[{ oldText: "header notpresent", newText: "x" }],
				"bin.dat",
			),
		/binary|NUL|not found/i,
	);
});

test("isDisproportionate guard: rejects a fuzzy span much larger than oldText (defense-in-depth)", () => {
	// Direct unit test of the guard. The curated fuzzy strategies all match a span
	// with the same line count as oldText, so this never fires through applyEdits
	// today — it exists to block any future partial-signal strategy from ballooning.
	const oldText = "{\n}"; // 2 lines
	const small = "{\n}"; // 2 lines → fine
	const huge = "{\n" + "filler\n".repeat(20) + "}"; // 22 lines → reject
	assert.equal(isDisproportionate(small, oldText), false);
	assert.equal(isDisproportionate(huge, oldText), true);
	// Single-line oldText never trips the char-based check.
	assert.equal(isDisproportionate("x", "x"), false);
});

test("empty oldText throws", () => {
	assert.throws(
		() => applyEdits("abc\n", [{ oldText: "", newText: "x" }], "e.txt"),
		/empty/i,
	);
});

test("oldText === newText throws", () => {
	assert.throws(
		() => applyEdits("abc\n", [{ oldText: "abc", newText: "abc" }], "e.txt"),
		/no changes|identical/i,
	);
});

test("missing oldText throws 'not found'", () => {
	assert.throws(
		() => applyEdits("abc def ghi\n", [{ oldText: "xyz long enough", newText: "q" }], "e.txt"),
		/not found/i,
	);
});

test("empty edits array throws", () => {
	assert.throws(
		() => applyEdits("abc\n", [], "e.txt"),
		/no edits/i,
	);
});
