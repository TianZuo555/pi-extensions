// Input-shape normalization: weak models emit many shapes for the same intent;
// all unambiguous ones must map onto the canonical {path, edits[]}.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareEditArguments } from "../lib/prepare-arguments.ts";

test("canonical shape passes through unchanged (idempotent)", () => {
	const input = { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] };
	const once = prepareEditArguments(input);
	assert.deepEqual(once, { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] });
	assert.deepEqual(prepareEditArguments(once), once);
});

test("top-level oldText/newText shorthand becomes a single edit", () => {
	const out = prepareEditArguments({ path: "a.ts", oldText: "x", newText: "y" });
	assert.deepEqual(out, { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] });
});

test("edits sent as a JSON string are parsed", () => {
	const out = prepareEditArguments({
		path: "a.ts",
		edits: JSON.stringify([{ oldText: "x", newText: "y" }]),
	});
	assert.deepEqual(out.edits, [{ oldText: "x", newText: "y" }]);
});

test("edits sent as a single object are wrapped into an array", () => {
	const out = prepareEditArguments({ path: "a.ts", edits: { oldText: "x", newText: "y" } });
	assert.deepEqual(out.edits, [{ oldText: "x", newText: "y" }]);
});

test("Claude-Code-style old_string/new_string and file_path are mapped", () => {
	const out = prepareEditArguments({ file_path: "a.ts", old_string: "x", new_string: "y" });
	assert.deepEqual(out, { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] });
});

test("opencode-style filePath/oldString/newString are mapped", () => {
	const out = prepareEditArguments({ filePath: "a.ts", oldString: "x", newString: "y" });
	assert.deepEqual(out, { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] });
});

test("alias keys inside edits[] entries are mapped", () => {
	const out = prepareEditArguments({
		path: "a.ts",
		edits: [{ old_string: "x", new_string: "y" }, { oldString: "p", newString: "q" }],
	});
	assert.deepEqual(out.edits, [
		{ oldText: "x", newText: "y" },
		{ oldText: "p", newText: "q" },
	]);
});

test("edits[] plus top-level shorthand are combined (shorthand appended last)", () => {
	const out = prepareEditArguments({
		path: "a.ts",
		edits: [{ oldText: "x", newText: "y" }],
		oldText: "p",
		newText: "q",
	});
	assert.deepEqual(out.edits, [
		{ oldText: "x", newText: "y" },
		{ oldText: "p", newText: "q" },
	]);
});

test("unusable input yields empty edits (error deferred to applyEdits)", () => {
	assert.deepEqual(prepareEditArguments(null).edits, []);
	assert.deepEqual(prepareEditArguments({ path: "a.ts" }).edits, []);
	assert.deepEqual(prepareEditArguments({ path: "a.ts", edits: "not json" }).edits, []);
	// Only one half of the pair present → not a usable edit.
	assert.deepEqual(prepareEditArguments({ path: "a.ts", oldText: "x" }).edits, []);
});

test("unmappable array entries are kept for applyEdits to reject precisely", () => {
	const out = prepareEditArguments({ path: "a.ts", edits: [{ bogus: 1 }] });
	assert.equal(out.edits.length, 1);
});
