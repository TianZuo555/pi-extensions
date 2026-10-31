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

test("a rejected highlight is remembered and never retried; a rejected loader is", async () => {
	let loads = 0;
	let highlights = 0;
	const cache = new ShikiHighlightCache(async () => {
		loads++;
		return async (code) => {
			highlights++;
			if (code === "bad") throw new Error("unsupported language");
			return `ok:${code}`;
		};
	});

	// highlight() 拒绝（不支持的语言等）：记入失败集合，同 key 不再起新任务。
	assert.equal(cache.get("bad", "brainfuck", "github-dark", ["fallback"]), undefined);
	await settle();
	assert.equal(
		cache.get("bad", "brainfuck", "github-dark", ["fallback"]),
		undefined,
		"a failed key returns undefined without new work",
	);
	await settle();
	assert.equal(highlights, 1, "failed highlight is not retried");
	assert.equal(loads, 1);

	// loader() 拒绝（模块导入失败）：不记失败，下次 get 重试。
	let loaderAttempts = 0;
	const retrying = new ShikiHighlightCache(async () => {
		loaderAttempts++;
		if (loaderAttempts === 1) throw new Error("module unavailable");
		return async (code) => `ok:${code}`;
	});
	assert.equal(retrying.get("x", "ts", "github-dark", ["x"]), undefined);
	await settle();
	assert.equal(retrying.get("x", "ts", "github-dark", ["x"]), undefined);
	await settle();
	assert.deepEqual(retrying.get("x", "ts", "github-dark", ["x"]), ["ok:x"]);
	assert.equal(loaderAttempts, 2, "the module import stays retryable");

	// clear() 连失败记录一起清：同 key 可以再试一次。
	cache.clear();
	assert.equal(cache.get("bad", "brainfuck", "github-dark", ["fallback"]), undefined);
	await settle();
	assert.equal(highlights, 2, "clear lets a failed key try once more");
});

test("failed keys are bounded like the success cache", async () => {
	let attempts = 0;
	const cache = new ShikiHighlightCache(async () => async () => {
		attempts++;
		throw new Error("nope");
	});
	for (let i = 0; i < 60; i++) cache.get(`code-${i}`, "ts", "github-dark", ["x"]);
	await settle();
	assert.equal(attempts, 60);
	// 失败集合超出 MAX_CACHE_ENTRIES(48) 后逐出最旧：code-0 已逐出，重试一次；
	// code-59 仍记着，不再起任务。
	cache.get("code-0", "ts", "github-dark", ["x"]);
	await settle();
	assert.equal(attempts, 61, "the evicted failure may retry once");
	cache.get("code-59", "ts", "github-dark", ["x"]);
	await settle();
	assert.equal(attempts, 61, "the newest failure stays cached");
});

test("oversized blocks are skipped", async () => {
	let attempts = 0;
	const cache = new ShikiHighlightCache(async () => async () => {
		attempts++;
		return "ok";
	});
	const oversized = "x".repeat(MAX_HL_CHARS + 1);
	assert.equal(cache.get(oversized, "ts", "github-dark", ["fallback"]), undefined);
	assert.equal(shouldHighlightCodeBlock("x".repeat(MAX_HL_CHARS)), true);
	assert.equal(shouldHighlightCodeBlock(oversized), false, "sync highlighting is also skipped");
	await settle();
	assert.equal(attempts, 0);
});
