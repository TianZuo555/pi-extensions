import assert from "node:assert/strict";
import test from "node:test";
import { getToolMouseTui, setToolMouseTui } from "../extensions/renderer/mouse/scroll.ts";

test("toolMouseTui getter reads the global slot written by setter", () => {
	const tui = { mode: "regular" };
	try {
		setToolMouseTui(tui);
		assert.equal(getToolMouseTui(), tui);
	} finally {
		setToolMouseTui(null);
	}
	assert.equal(getToolMouseTui(), null);
});
