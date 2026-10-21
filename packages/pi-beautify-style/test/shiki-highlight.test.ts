import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_HL_CHARS,
	ShikiHighlightCache,
} from "../extensions/renderer/tool/diff/shiki-highlight.ts";
import { shouldHighlightCodeBlock } from "../extensions/renderer/tool/diff/diff-renderer.ts";
import { sanitizeToolResultText } from "../extensions/utils/tool-result-sanitize.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Shiki cache deduplicates pending work, caches success, and isolates themes", async () => {
	let loads = 0;
	let highlights = 0;
	const cache = new ShikiHighlightCache(async () => {
		loads++;
		return async (code, _lang, theme) => {
			highlights++;
			return `${theme}:${code}`;
		};
	});
	let invalidations = 0;
	assert.equal(
		cache.get("const x = 1", "ts", "github-dark", ["fallback"], () => invalidations++),
		undefined,
	);
	assert.equal(
		cache.get("const x = 1", "ts", "github-dark", ["fallback"], () => invalidations++),
		undefined,
	);
	await settle();
	assert.equal(loads, 1);
	assert.equal(highlights, 1);
	assert.deepEqual(cache.get("const x = 1", "ts", "github-dark", ["fallback"]), [
		"github-dark:const x = 1",
	]);
	assert.equal(invalidations, 2, "every component awaiting the shared block repaints");
	assert.equal(cache.get("const x = 1", "ts", "github-light", ["fallback"]), undefined);
	await settle();
	assert.equal(highlights, 2);
});

test("terminal controls are removed before source highlighting", () => {
	assert.equal(
		sanitizeToolResultText("safe\x1b]52;c;SGVsbG8=\x07mid\x1bP1;2|payload\x1b\\end\x1b[31m"),
		"safemidend",
	);
	assert.equal(
		sanitizeToolResultText(
			"a\x9d52;c;C1_OSC\x9cb\x90C1_DCS\x9cc\x1b]52;c;ESC_OSC\x9cd\x1bPESC_DCS\x9ce",
		),
		"abcde",
	);
});

test("Shiki failures degrade without caching, retry, and oversized blocks are skipped", async () => {
	let attempts = 0;
	const cache = new ShikiHighlightCache(async () => async (code) => {
		attempts++;
		if (attempts === 1) throw new Error("temporary");
		return `ok:${code}`;
	});
	assert.equal(cache.get("x", "ts", "github-dark", ["x"]), undefined);
	await settle();
	assert.equal(cache.get("x", "ts", "github-dark", ["x"]), undefined, "failed work is retryable");
	await settle();
	assert.deepEqual(cache.get("x", "ts", "github-dark", ["x"]), ["ok:x"]);
	assert.equal(attempts, 2);
	const oversized = "x".repeat(MAX_HL_CHARS + 1);
	assert.equal(cache.get(oversized, "ts", "github-dark", ["fallback"]), undefined);
	assert.equal(shouldHighlightCodeBlock("x".repeat(MAX_HL_CHARS)), true);
	assert.equal(shouldHighlightCodeBlock(oversized), false, "sync highlighting is also skipped");
	await settle();
	assert.equal(attempts, 2);
});
