// Step labels for raw chain-of-thought reasoning (DeepSeek, GLM, Kimi, Claude, …).
// These providers stream no headings, so the card would only say `Thinking...`.
// The reasoning still narrates itself: one paragraph per thought, an intent
// sentence (`Let me check X.`) for the next action, a pivot word (`Wait`,
// `Actually`) for a rethink, and a labeled lead (`Plan:`, `Decision:`) for a
// milestone. Each paragraph gives at most one step.
import { visibleWidth } from "@earendil-works/pi-tui";

export type ThinkingStepKind = "intent" | "rethink" | "milestone";

export type ThinkingStep = {
	kind: ThinkingStepKind;
	label: string;
};

/** Max columns of a step label, so the duration after it stays visible. */
const MAX_STEP_WIDTH = 60;

const LEAD_WORDS =
	"ok|okay|so|now|next|then|first|finally|good|great|alright|right|actually|wait|hmm+|but|and|also|instead|alternatively";
const INTENT_EN = new RegExp(
	`^(?:(?:${LEAD_WORDS})[,.!:;—–-]*\\s+)*(?:let me|let's|let us|i'll|i will|i'm going to|i need to)\\s+(?:(?:also|quickly|first|now|just|then|next|still)\\s+)*(.+)$`,
	"i",
);
const INTENT_ZH =
	/^(?:好的?|那么|现在|接下来|然后|首先|最后|嗯|不过|其实)?[，,、\s]*(?:让我|我来|我先|我需要|我要|我将|下一步)[，,：:\s]*(.+)$/;
const PIVOT_EN = /^(?:wait|actually|but wait|alternatively|hold on|on second thought|instead)\b/i;
const PIVOT_ZH = /^(?:不对|等等|其实|或者|换个思路)/;
const MILESTONE =
	/^(plan|decision|conclusion|confirmed|root cause|key question|approach|goal|summary|fix|findings?|result|answer|计划|结论|决定|方案|原因|根因|目标)[ \t]*[:：][ \t]*([\s\S]*)$/i;
const LIST_MARKER = /^\s*(?:\d+[.)]|[-*•])\s+/;
/** End of a complete sentence or line. A `.` counts only before whitespace, so `foo.ts` is not cut. */
const BOUNDARY = /[.!?](?=\s)|[。！？]|\n/g;

function completePart(text: string): string {
	let end = 0;
	for (const match of text.matchAll(BOUNDARY)) end = match.index + match[0].length;
	return text.slice(0, end);
}

function sentences(paragraph: string): string[] {
	return paragraph
		.split("\n")
		.flatMap((line) => line.split(/(?<=[.!?])\s+(?=\S)|(?<=[。！？])/))
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

function clean(text: string): string {
	const plain = text
		.replace(/\s+/g, " ")
		.replace(/[\s.!?:;,。！？：；，…]+$/, "")
		.trim();
	if (visibleWidth(plain) <= MAX_STEP_WIDTH) return plain;
	let out = "";
	let width = 0;
	for (const char of plain) {
		const charWidth = visibleWidth(char);
		if (width + charWidth > MAX_STEP_WIDTH - 1) break;
		out += char;
		width += charWidth;
	}
	return `${out.trimEnd()}…`;
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function milestoneStep(paragraph: string): ThinkingStep | undefined {
	const match = MILESTONE.exec(paragraph);
	if (!match) return undefined;
	const lead = capitalize(match[1]);
	const first = match[2]
		.split("\n")
		.map((line) => line.replace(LIST_MARKER, "").trim())
		.find(Boolean);
	const detail = first ? clean(sentences(first)[0] ?? "") : "";
	return { kind: "milestone", label: detail ? clean(`${lead}: ${detail}`) : lead };
}

function intentStep(paragraph: string): ThinkingStep | undefined {
	const all = sentences(paragraph);
	for (let i = all.length - 1; i >= 0; i--) {
		const sentence = all[i];
		const english = INTENT_EN.exec(sentence);
		const action = english?.[1] ?? INTENT_ZH.exec(sentence)?.[1];
		if (!action || /^know\b/i.test(action)) continue;
		const label = clean(english ? capitalize(action) : action);
		if (label.length < 3) continue;
		const pivot = PIVOT_EN.test(sentence) || PIVOT_ZH.test(sentence);
		return { kind: pivot ? "rethink" : "intent", label };
	}
	return undefined;
}

/**
 * Steps found in reasoning text, oldest first. While the text streams, the
 * unfinished last sentence is ignored, so a label never shows half a word.
 */
export function parseThinkingSteps(text: string, streaming: boolean): ThinkingStep[] {
	const source = (streaming ? completePart(text) : text)
		// Code in a fence is quoted material, not narration. An open fence runs to the end.
		.replace(/```[\s\S]*?(?:```|$)/g, "\n")
		.replace(/\*\*|`/g, "");
	const steps: ThinkingStep[] = [];
	for (const raw of source.split(/\n[ \t]*\n/)) {
		const paragraph = raw.trim();
		if (!paragraph) continue;
		const step = milestoneStep(paragraph) ?? intentStep(paragraph);
		if (step) steps.push(step);
	}
	return steps;
}

/** Card text of one step. */
export function formatThinkingStep(step: ThinkingStep): string {
	return step.kind === "rethink" ? clean(`Rethinking: ${step.label}`) : step.label;
}

export function formatStepCount(count: number): string {
	return count === 1 ? "1 step" : `${count} steps`;
}
