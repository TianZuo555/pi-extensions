import assert from "node:assert/strict";
import test from "node:test";
import {
	formatStepCount,
	formatThinkingStep,
	parseThinkingSteps,
} from "../extensions/feature/thinking-steps.ts";

const labels = (text: string, streaming = false) =>
	parseThinkingSteps(text, streaming).map(formatThinkingStep);

// Shapes below come from real `reasoning_content` of openai-completions flash models.
test("each paragraph gives its last intent sentence as one step", () => {
	const text = [
		"So the nsh-compat repo is up to date with origin. That's a pre-existing breakage.",
		"But wait, maybe CI's compat job checks out nsh-compat at a fixed commit? Let me look at .github/workflows for compat.",
		"Docs look good. Now wait for gallery tests.",
		"Let me check the tmp screenshots. Let me run a broad search for `playwright` in workspace repos.",
	].join("\n\n");
	assert.deepEqual(labels(text), [
		"Look at .github/workflows for compat",
		"Run a broad search for playwright in workspace repos",
	]);
});

test("labeled leads become milestones and list markers leave the label", () => {
	const text = "Plan:\n1. Backup + edit 3 configs.\n2. Restart magpie.\n\nDecision: keep apiKeyEnv as is.";
	assert.deepEqual(labels(text), ["Plan: Backup + edit 3 configs", "Decision: keep apiKeyEnv as is"]);
});

test("a pivot that opens the intent sentence marks a rethink", () => {
	assert.deepEqual(labels("Actually, let me diff against main instead."), [
		"Rethinking: Diff against main instead",
	]);
	assert.deepEqual(labels("Hmm, odd. Let me check the logs."), ["Check the logs"]);
});

test("Chinese intent sentences are steps too", () => {
	assert.deepEqual(labels("配置已经读到了。接下来让我检查日志文件。"), ["检查日志文件"]);
});

test("streaming ignores the unfinished last sentence", () => {
	assert.deepEqual(labels("Let me read foo.", true), [], "`foo.` may still grow into `foo.ts`");
	assert.deepEqual(labels("Let me read foo.ts", true), []);
	assert.deepEqual(labels("Let me read foo.ts. Then", true), ["Read foo.ts"]);
	assert.deepEqual(labels("Let me read foo.ts\n", true), ["Read foo.ts"]);
	assert.deepEqual(labels("让我检查日志。", true), ["检查日志"]);
});

test("fenced code and `let me know` are not steps", () => {
	assert.deepEqual(labels("```\nLet me in.\n```\n\nI'd say: let me know.\n\nLet me know if it fails."), []);
});

test("long labels are cut to a fixed width", () => {
	const [label] = labels(`Let me grep ${"x".repeat(100)}.`);
	assert.equal(label.length, 60);
	assert.ok(label.endsWith("…"));
	assert.equal(formatStepCount(1), "1 step");
	assert.equal(formatStepCount(3), "3 steps");
});
