import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ExpandedToolIoView } from "../extensions/renderer/tool/tool-io.ts";

const theme = {
	fg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as any;

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
/** Output 正文前缀是 3 格（lead + 2），其后是源行缩进。 */
const bodyIndent = (line: string) => /^ {3}( *)\S/.exec(plain(line))?.[1].length ?? -1;

test("wrapped output keeps the source indentation on continuation rows", () => {
	const source = "    alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
	const view = new ExpandedToolIoView(theme, "", source, false, 40, 5);
	const rows = view.render(60).filter((line) => /alpha|eta|theta|lambda mu/.test(plain(line)));

	assert.ok(rows.length >= 2, "the 68-column line wraps inside a 60-column view");
	for (const row of rows) {
		assert.equal(bodyIndent(row), 4, `continuation keeps the 4-space indent: ${plain(row)}`);
	}
	assert.ok(
		view.render(60).every((line) => visibleWidth(line) <= 60),
		"indented wrapping stays inside the view width",
	);
});

test("deep indentation is clamped so text stays readable", () => {
	const source = `${" ".repeat(40)}alpha beta gamma delta epsilon zeta eta theta iota kappa`;
	const view = new ExpandedToolIoView(theme, "", source, false, 40, 5);
	const rows = view.render(60).filter((line) => /alpha|iota/.test(plain(line)));

	assert.ok(rows.length >= 2, "the deeply indented line wraps");
	for (const row of rows) {
		const indent = bodyIndent(row);
		assert.ok(indent >= 0 && indent <= 30, `indent stays within half the width: ${indent}`);
		assert.match(plain(row), /\S {0,}\S|\S$/, "wrapped rows keep real content");
	}
});
