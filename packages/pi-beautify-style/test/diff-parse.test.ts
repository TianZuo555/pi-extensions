import assert from "node:assert/strict";
import test from "node:test";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { parseDiff, type DiffLineEntry } from "../extensions/renderer/tool/diff/diff-parse.ts";

const expectedLines = [
	{
		lineKind: "context",
		oldLineNumber: 1,
		newLineNumber: 1,
		fallbackLineNumber: "1",
		content: "alpha",
	},
	{
		lineKind: "remove",
		oldLineNumber: 2,
		newLineNumber: null,
		fallbackLineNumber: "2",
		content: "beta",
	},
	{
		lineKind: "add",
		oldLineNumber: null,
		newLineNumber: 2,
		fallbackLineNumber: "2",
		content: "BETA",
	},
	{
		lineKind: "context",
		oldLineNumber: 3,
		newLineNumber: 3,
		fallbackLineNumber: "3",
		content: "gamma",
	},
];

function lineEntries(diff: string): DiffLineEntry[] {
	return parseDiff(diff).entries.filter((entry): entry is DiffLineEntry => entry.kind === "line");
}

function comparableLines(lines: DiffLineEntry[]) {
	return lines.map(({ lineKind, oldLineNumber, newLineNumber, fallbackLineNumber, content }) => ({
		lineKind,
		oldLineNumber,
		newLineNumber,
		fallbackLineNumber,
		content,
	}));
}

for (const [format, diff] of [
	["pi space-delimited", generateDiffString("alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n").diff],
	["OMP pipe-delimited", " 1|alpha\n-2|beta\n+2|BETA\n 3|gamma"],
	["OMP pipe-delimited with hunk header", "@@ -1,3 +1,3 @@\n 1|alpha\n-2|beta\n+2|BETA\n 3|gamma"],
] as const) {
	test(`diff parser supports ${format} rows`, () => {
		const lines = lineEntries(diff);
		assert.deepEqual(comparableLines(lines), expectedLines);
		assert.ok(
			lines.every((line) => !/^\d+\s/.test(line.content)),
			"line numbers must populate the gutter instead of remaining in source content",
		);
	});
}

test("unified hunks preserve numeric source content and use hunk line numbers", () => {
	const diff = "@@ -1,2 +1,2 @@\n-100 apples\n+200 apples\n 300 pears";
	assert.deepEqual(comparableLines(lineEntries(diff)), [
		{
			lineKind: "remove",
			oldLineNumber: 1,
			newLineNumber: null,
			fallbackLineNumber: "1",
			content: "100 apples",
		},
		{
			lineKind: "add",
			oldLineNumber: null,
			newLineNumber: 1,
			fallbackLineNumber: "1",
			content: "200 apples",
		},
		{
			lineKind: "context",
			oldLineNumber: 2,
			newLineNumber: 2,
			fallbackLineNumber: "2",
			content: "300 pears",
		},
	]);
});

test("unified patches preserve indented numeric content across hunks and files", () => {
	const diff = [
		"diff --git a/counts.txt b/counts.txt",
		"--- a/counts.txt",
		"+++ b/counts.txt",
		"@@ -40,3 +60,4 @@",
		" 123 count",
		"-  456 units",
		"+  789 units",
		"+  321 units",
		" \t987 value",
		"@@ -80 +101 @@",
		"-5 more",
		"+6 more",
		"diff --git a/other.txt b/other.txt",
		"--- a/other.txt",
		"+++ b/other.txt",
		"@@ -1 +1 @@",
		"-7 old",
		"+8 new",
	].join("\n");
	assert.deepEqual(
		lineEntries(diff).map(({ lineKind, oldLineNumber, newLineNumber, content }) => [
			lineKind,
			oldLineNumber,
			newLineNumber,
			content,
		]),
		[
			["context", 40, 60, "123 count"],
			["remove", 41, null, "  456 units"],
			["add", null, 61, "  789 units"],
			["add", null, 62, "  321 units"],
			["context", 42, 63, "\t987 value"],
			["remove", 80, null, "5 more"],
			["add", null, 101, "6 more"],
			["remove", 1, null, "7 old"],
			["add", null, 1, "8 new"],
		],
	);
});

test("pi numbered rows preserve numeric source content, whitespace, and padding", () => {
	const before = [
		"100 apples",
		"300 pears",
		"",
		"  indented",
		"\ttab",
		"|pipe",
		"7",
		"8",
		"9",
		"10",
	];
	const after = ["200 apples", ...before.slice(1)];
	const diff = generateDiffString(before.join("\n"), after.join("\n"), 10).diff;
	const lines = lineEntries(diff);
	assert.deepEqual(
		lines.map(({ lineKind, oldLineNumber, newLineNumber, content }) => [
			lineKind,
			oldLineNumber,
			newLineNumber,
			content,
		]),
		[
			["remove", 1, null, "100 apples"],
			["add", null, 1, "200 apples"],
			["context", 2, 2, "300 pears"],
			["context", 3, 3, ""],
			["context", 4, 4, "  indented"],
			["context", 5, 5, "\ttab"],
			["context", 6, 6, "|pipe"],
			["context", 7, 7, "7"],
			["context", 8, 8, "8"],
			["context", 9, 9, "9"],
			["context", 10, 10, "10"],
		],
	);
	assert.deepEqual(
		lines.map((line) => line.fallbackLineNumber),
		["1", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
	);
});

for (const [lineCount, omission] of [
	[9, "   ..."],
	[30, "    ..."],
	[100, "     ..."],
] as const) {
	test(`pi omission markers are semantic entries with ${lineCount}-line number padding`, () => {
		const before = Array.from({ length: lineCount }, (_, index) => `line-${index + 1}`);
		const after = before.map((line, index) => (index === 1 ? "line-2 changed" : line));
		const { diff } = generateDiffString(before.join("\n"), after.join("\n"));
		const parsed = parseDiff(diff);

		assert.deepEqual(parsed.entries.at(-1), {
			kind: "omission",
			raw: omission,
			hunkIndex: 1,
		});
		assert.equal(parsed.stats.context, 5, "omitted context is not an actual source row");
	});
}

test("pi leading, intermediate, and trailing omissions stay out of source counts", () => {
	const before = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`);
	const after = before.map((line, index) =>
		index === 10 || index === 29 ? `${line} changed` : line,
	);
	const { diff } = generateDiffString(before.join("\n"), after.join("\n"));
	const parsed = parseDiff(diff);
	const omissions = parsed.entries.filter((entry) => entry.kind === "omission");

	assert.deepEqual(
		omissions.map((entry) => entry.raw),
		["    ...", "    ...", "    ..."],
	);
	assert.equal(parsed.entries[0], omissions[0]);
	assert.equal(parsed.entries.at(-1), omissions[2]);
	assert.deepEqual(parsed.stats, {
		added: 2,
		removed: 2,
		context: 16,
		hunks: 1,
		files: 1,
		lines: 23,
	});
	assert.deepEqual(
		lineEntries(diff)
			.filter((line) => line.lineKind === "context")
			.map(({ oldLineNumber, newLineNumber }) => [oldLineNumber, newLineNumber]),
		[
			[7, 7],
			[8, 8],
			[9, 9],
			[10, 10],
			[12, 12],
			[13, 13],
			[14, 14],
			[15, 15],
			[26, 26],
			[27, 27],
			[28, 28],
			[29, 29],
			[31, 31],
			[32, 32],
			[33, 33],
			[34, 34],
		],
	);
});

for (const format of ["pi", "unified"] as const) {
	test(`${format} literal ellipsis source rows retain their numbers and indentation`, () => {
		const before = "before\n...\n   ...\nafter";
		const after = "BEFORE\n...\n   ...\nafter";
		const diff =
			format === "pi"
				? generateDiffString(before, after).diff
				: "@@ -1,4 +1,4 @@\n-before\n+BEFORE\n ...\n    ...\n after";
		const parsed = parseDiff(diff);

		assert.equal(parsed.stats.context, 3);
		assert.ok(parsed.entries.every((entry) => entry.kind !== "omission"));
		assert.deepEqual(
			lineEntries(diff)
				.filter((line) => line.content.trim() === "...")
				.map(({ oldLineNumber, newLineNumber, content }) => [
					oldLineNumber,
					newLineNumber,
					content,
				]),
			[
				[2, 2, "..."],
				[3, 3, "   ..."],
			],
		);
	});
}

for (const header of ["", "@@ -1,3 +1,3 @@\n"]) {
	test(`hashline anchors remain available ${header ? "with" : "without"} hunk headers`, () => {
		const lines = lineEntries(`${header} 1#AB:alpha\n-2#CD:beta\n+2#  :BETA\n 3#EF:gamma`);
		assert.deepEqual(comparableLines(lines), expectedLines);
		assert.deepEqual(
			lines.map((line) => line.hashlineAnchorContent),
			["1#AB:alpha", "2#CD:beta", "2#  :BETA", "3#EF:gamma"],
		);
	});
}
