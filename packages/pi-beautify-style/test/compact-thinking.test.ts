import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
	clearThinkingPreviewCache,
	installCompactThinking,
	isAllThinkingExpanded,
	ThinkingPreviewBlock,
} from "../extensions/feature/compact-thinking.ts";
import { DEFAULT_CONFIG } from "../extensions/config/config.ts";
import { animateCompactThinkingText } from "../extensions/renderer/compact-mode.ts";

const config = {
	useSummaryTitlesAsThinkingTitle: false,
	liveThinkingLines: 0,
	animationIntervalMs: 30,
};

test("collapsed thinking previews memoize complete output until invalidated", () => {
	const originalConfig = { ...config };
	const { pi } = runtime();
	const controller = installCompactThinking(pi, { ...originalConfig });
	controller.updateConfig({ ...originalConfig, liveThinkingLines: 1 });
	clearThinkingPreviewCache();
	try {
		const preview = new ThinkingPreviewBlock(
			"Thought",
			"alpha beta gamma delta epsilon zeta eta theta",
			0,
			1,
			(text) => text,
		);
		const first = preview.render(12);
		assert.ok(
			first.some((line) => line.includes("more")),
			"composed output includes its hint",
		);
		assert.strictEqual(preview.render(12), first, "same state reuses complete output");

		assert.notStrictEqual(preview.render(16), first, "width changes recompute output");
		const beforeConfigChange = preview.render(16);
		controller.updateConfig({ ...originalConfig, liveThinkingLines: 2 });
		assert.notStrictEqual(
			preview.render(16),
			beforeConfigChange,
			"preview-line changes recompute output",
		);

		const beforeHover = preview.render(16);
		preview.setHintHovered(true);
		assert.notStrictEqual(preview.render(16), beforeHover, "hover changes recompute output");

		const beforeInvalidation = preview.render(16);
		preview.invalidate();
		assert.notStrictEqual(preview.render(16), beforeInvalidation, "invalidation clears memo");
	} finally {
		controller.updateConfig(originalConfig);
		clearThinkingPreviewCache();
	}
});

test("thinking 展开态按消息时间戳与 run 序号记，换实例后仍生效", () => {
	const originalConfig = { ...config };
	const { pi } = runtime();
	const controller = installCompactThinking(pi, { ...originalConfig, liveThinkingLines: 1 });
	clearThinkingPreviewCache();
	try {
		const body = "alpha beta gamma delta epsilon";
		// 同一个 run 的两个实例：内容重建会换掉实例，旧实例还留在布局里
		const stale = new ThinkingPreviewBlock("Thought", body, 0, 7, (text) => text, undefined, 0);
		const live = new ThinkingPreviewBlock("Thought", body, 0, 7, (text) => text, undefined, 0);
		const nextRun = new ThinkingPreviewBlock("Thought", body, 0, 7, (text) => text, undefined, 1);
		assert.equal(live.expanded, false, "默认收起");
		assert.equal(
			live.render(40).some((line) => line.includes("alpha")),
			false,
		);

		stale.setExpanded(true);
		assert.equal(live.expanded, true, "同一 run 的新实例跟着展开");
		assert.ok(
			live.render(40).some((line) => line.includes("alpha")),
			"新实例渲染展开后的正文",
		);
		assert.equal(nextRun.expanded, false, "同一消息的另一段 thinking 不受影响");

		stale.setExpanded(false);
		assert.equal(live.expanded, false, "收起也按同一个键共享");
		assert.equal(
			live.render(40).some((line) => line.includes("alpha")),
			false,
		);
	} finally {
		controller.updateConfig(originalConfig);
		clearThinkingPreviewCache();
	}
});

test("compact summary reuses compact-thinking's sweep animation", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		italic: (text: string) => `<i>${text}</i>`,
		bold: (text: string) => `<b>${text}</b>`,
	} as any;
	const first = animateCompactThinkingText("Thinking...", theme, 0);
	const second = animateCompactThinkingText("Thinking...", theme, 1);
	assert.notEqual(first, second);
	assert.equal(first.replace(/<[^>]+>/g, ""), "Thinking...");
	assert.equal(second.replace(/<[^>]+>/g, ""), "Thinking...");
});

function runtime() {
	const handlers = new Map<string, Function[]>();
	return {
		handlers,
		pi: {
			on(name: string, handler: Function) {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			appendEntry() {},
		} as any,
		emit(name: string, event: any = {}, ctx: any = {}) {
			for (const handler of handlers.get(name) ?? []) handler(event, ctx);
		},
	};
}

const tuiCtx = {
	mode: "tui",
	sessionManager: { getBranch: () => [], getEntries: () => [] },
	ui: { theme: {}, setWidget() {}, requestRender() {} },
};

const headlessCtx = {
	mode: "print",
	hasUI: false,
	sessionManager: { getBranch: () => [], getEntries: () => [] },
	ui: { theme: {}, setWidget() {}, requestRender() {} },
};

test("compact thinking patches the runtime component with ccstyle config", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const { emit, pi } = runtime();
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	try {
		installCompactThinking(pi, config);
		// Lazy: prototype stays original until a TUI session starts.
		assert.equal(AssistantMessageComponent.prototype.updateContent, original);
		emit("session_start", {}, tuiCtx);
		assert.notEqual(AssistantMessageComponent.prototype.updateContent, original);
		assert.equal(
			existsSync(join(dir, "compact-thinking.json")),
			false,
			"activate must not leave compact-thinking.json behind",
		);
	} finally {
		emit("session_shutdown", {}, tuiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reload keeps the replacement compact-thinking prototype patch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-reload-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	const first = runtime();
	const second = runtime();
	try {
		installCompactThinking(first.pi, config);
		first.emit("session_start", {}, tuiCtx);
		const firstPatch = AssistantMessageComponent.prototype.updateContent;

		installCompactThinking(second.pi, config);
		second.emit("session_start", {}, tuiCtx);
		const replacementPatch = AssistantMessageComponent.prototype.updateContent;
		assert.notEqual(replacementPatch, firstPatch);
		first.emit("session_shutdown", {}, tuiCtx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, replacementPatch);

		second.emit("session_shutdown", {}, tuiCtx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, original);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("headless subagent runtime does not steal the parent thinking patch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-isolate-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	const parent = runtime();
	const nested = runtime();
	try {
		installCompactThinking(parent.pi, config);
		parent.emit("session_start", {}, tuiCtx);
		const parentPatch = AssistantMessageComponent.prototype.updateContent;
		assert.notEqual(parentPatch, original);

		installCompactThinking(nested.pi, config);
		nested.emit("session_start", {}, headlessCtx);
		assert.equal(
			AssistantMessageComponent.prototype.updateContent,
			parentPatch,
			"headless install must not replace the parent prototype patch",
		);

		nested.emit("session_shutdown", {}, headlessCtx);
		assert.equal(
			AssistantMessageComponent.prototype.updateContent,
			parentPatch,
			"headless shutdown must not tear down the parent patch",
		);
	} finally {
		parent.emit("session_shutdown", {}, tuiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

const renderText = (component: any, width = 120): string[] =>
	component
		.render(width)
		.map((line: string) =>
			line
				.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
				.replace(/\x1b\][^\x07]*\x07/g, "")
				.trim(),
		)
		.filter((line: string) => line);

function thinkingMessage(timestamp: number, withAgent = true) {
	return {
		role: "assistant",
		timestamp,
		content: [
			{
				type: "thinking",
				thinking: "plan",
				thinkingSignature: { kind: "agent_summary", title: "Plan", body: "..." },
			},
			...(withAgent ? [{ type: "toolCall", name: "Agent", arguments: {} }] : []),
		],
	} as unknown as AssistantMessage;
}

function themeCtx(sessionManager: any = { getBranch: () => [], getEntries: () => [] }) {
	return {
		mode: "tui",
		sessionManager,
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget() {},
			requestRender() {},
		},
	};
}

test("session tree restores durations from all entries so old messages keep Thought for", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-restore-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	let durationEntry: any = {
		type: "custom",
		customType: "compact-thinking-duration",
		data: { messageTimestamp: 0, contentIndex: 0, durationMs: 1234 },
	};
	const sessionManager = {
		// getBranch mirrors the leaf path after compaction: it no longer contains
		// the finished message's duration entry. getEntries still has it.
		getBranch: () => [] as any[],
		getEntries: () => [durationEntry],
	};
	const uiCtx = themeCtx(sessionManager);
	try {
		installCompactThinking(pi, config);
		emit("session_start", {}, uiCtx);

		const oldTs = Date.now() - 60_000;
		durationEntry.data.messageTimestamp = oldTs;
		const msg = thinkingMessage(oldTs, false);
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});

		// compaction: session_tree with a leaf path that no longer includes the message
		emit("session_tree", {}, uiCtx);

		// scrolling back re-renders the old message in a fresh component
		const old = new AssistantMessageComponent(msg, true);
		old.updateContent(msg);
		const lines = renderText(old);
		assert.ok(
			lines.some((line) => line.startsWith("Thought for")),
			`old message keeps its duration after compaction, got: ${lines[0]}`,
		);
		assert.ok(!lines.some((line) => line.includes("Thinking...")), "no bare Thinking... fallback");
	} finally {
		emit("session_shutdown", {}, uiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact summary keeps the shared animation alive until the next assistant message", async () => {
	const { emit, pi } = runtime();
	const uiCtx = themeCtx();
	const controller = installCompactThinking(pi, config);
	try {
		emit("session_start", {}, uiCtx);
		const message = {
			...thinkingMessage(Date.now(), false),
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "toolCall", name: "bash", args: {} },
			],
		};
		emit("message_update", {
			message,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		controller.setCompactSummaryActive?.(true);
		emit("message_update", {
			message,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});
		assert.equal(controller.isMessageThinkingActive?.(message.timestamp), false);
		const runningFrame = controller.getThinkingAnimationFrame?.() ?? 0;
		await new Promise((resolve) => setTimeout(resolve, 70));
		assert.ok((controller.getThinkingAnimationFrame?.() ?? 0) > runningFrame);

		controller.setCompactSummaryActive?.(false);
		const stoppedFrame = controller.getThinkingAnimationFrame?.() ?? 0;
		await new Promise((resolve) => setTimeout(resolve, 70));
		assert.equal(controller.getThinkingAnimationFrame?.(), stoppedFrame);
	} finally {
		emit("session_shutdown", {}, uiCtx);
	}
});

test("Agent tool execution keeps the thinking animation until the next boundary", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-agent-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const uiCtx = themeCtx();
	try {
		const controller = installCompactThinking(pi, config);
		emit("session_start", {}, uiCtx);

		const ts = Date.now();
		const msg = thinkingMessage(ts, true); // thinking + Agent toolCall
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(controller.isMessageThinkingActive?.(ts), true);
		assert.ok(
			(controller.getThinkingAnimationFrame?.() ?? 0) > 0,
			"animation frame follows compact-thinking's configured timer",
		);
		assert.ok(
			(controller.getMessageThinkingDurationMs?.(ts) ?? 0) > 0,
			"active thinking exposes compact-thinking's live elapsed duration",
		);
		// toolcall_start carries the Agent toolCall: animation must survive
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});

		// Real agent-loop order: message_end, then tool_execution_start(Agent).
		emit("message_end", { message: msg }, uiCtx);
		emit("tool_execution_start", { toolName: "Agent", toolCallId: "c1", args: {} }, uiCtx);

		// Nested headless runtime must not kill the ticker mid-run.
		const nested = runtime();
		installCompactThinking(nested.pi, config);
		nested.emit("session_start", {}, headlessCtx);

		const midAgent = new AssistantMessageComponent(msg, true);
		midAgent.updateContent(msg);
		const midLines = renderText(midAgent);
		assert.ok(
			midLines.some((line) => line.includes("Thinking")),
			`during Agent execution the thinking ticker stays active, got: ${midLines[0]}`,
		);
		assert.ok(
			!midLines.some((line) => line.includes("Thought for")),
			"not finalized while the subagent runs",
		);

		// tool_execution_end(Agent): finalize once the subagent returns
		emit(
			"tool_execution_end",
			{ toolName: "Agent", toolCallId: "c1", result: {}, isError: false },
			uiCtx,
		);
		assert.equal(controller.isMessageThinkingActive?.(ts), false);
		assert.ok(
			(controller.getMessageThinkingDurationMs?.(ts) ?? 0) > 0,
			"completed thinking exposes its final duration",
		);
		const after = new AssistantMessageComponent(msg, true);
		after.updateContent(msg);
		const afterLines = renderText(after);
		assert.ok(
			afterLines.some((line) => line.startsWith("Thought for")),
			`finalized once the subagent ends, got: ${afterLines[0]}`,
		);

		nested.emit("session_shutdown", {}, headlessCtx);
	} finally {
		emit("session_shutdown", {}, uiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reload/resume rebuild: mounted-tree scan re-renders rebuilt components", async () => {
	initTheme("dark");
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-rescan-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { Container } = await import("@earendil-works/pi-tui");
	const parent = new Container() as any;
	const tui = {
		mode: "regular",
		getMountedRoots: () => [parent],
		requestRender() {},
	};
	const entries: any[] = [];
	const sessionManager = { getBranch: () => entries, getEntries: () => entries };
	const ctx = {
		mode: "tui",
		sessionManager,
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") factory(tui);
			},
			requestRender() {},
		},
	} as any;
	const first = runtime();
	first.pi.appendEntry = (_type: string, data: unknown) =>
		entries.push({ type: "custom", customType: "compact-thinking-duration", data });
	try {
		installCompactThinking(first.pi, config);
		first.emit("session_start", {}, ctx);

		// live run: thinking then toolcall records the duration entry
		const ts = Date.now();
		const msg = thinkingMessage(ts, false);
		first.emit(
			"message_update",
			{ message: msg, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
			ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		first.emit(
			"message_update",
			{ message: msg, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } },
			ctx,
		);

		first.emit("session_shutdown", { reason: "reload" }, ctx);

		// pi rebuildChatFromMessages: fresh components with the restored ORIGINAL prototype
		parent.clear();
		const rebuilt = new AssistantMessageComponent(msg, true) as any;
		parent.addChild(rebuilt);
		assert.ok(
			renderText(rebuilt).some((line) => line.startsWith("Thinking...")),
			"native rebuild shows the bare Thinking... label",
		);

		// new extension instance: session_start scans the mounted tree and re-renders
		const second = runtime();
		installCompactThinking(second.pi, config);
		second.emit("session_start", { reason: "reload" }, ctx);
		const lines = renderText(rebuilt);
		assert.ok(
			lines.some((line) => line.startsWith("Thought for")),
			`rebuilt component recovers its duration, got: ${JSON.stringify(lines)}`,
		);
		assert.ok(
			!lines.some((line) => line.includes("Thinking...")),
			`no bare Thinking... fallback after reload, got: ${JSON.stringify(lines)}`,
		);

		second.emit("session_shutdown", {}, ctx);
	} finally {
		first.emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("completed run without duration never falls back to the loading label", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-fallback-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") factory({ requestRender() {} });
			},
			requestRender() {},
		},
	} as any;
	try {
		installCompactThinking(pi, { ...config, useSummaryTitlesAsThinkingTitle: true });
		emit("session_start", {}, ctx);
		// completed run with no duration entry: summary title preferred, then "Thought"
		const withSummary = {
			...thinkingMessage(Date.now(), false),
			api: "openai-responses",
			content: [
				{
					type: "thinking",
					thinking: "**Plan**\n\nFirst do A",
					thinkingSignature: {
						type: "reasoning",
						summary: [{ type: "summary_text", text: "**Plan**\n\nFirst do A" }],
					},
				},
				{ type: "toolCall", name: "bash", args: {}, id: "c1" },
			],
		} as any;
		const component = new AssistantMessageComponent(withSummary, true) as any;
		component.updateContent(withSummary);
		const withSummaryLines = renderText(component);
		assert.ok(
			withSummaryLines.some((line) => line.includes("Plan")),
			`summary title shown for completed run, got: ${JSON.stringify(withSummaryLines)}`,
		);
		assert.ok(
			!withSummaryLines.some((line) => line.includes("Thinking...")),
			"no loading label for a completed run",
		);

		const plain = thinkingMessage(Date.now(), false);
		const plainComponent = new AssistantMessageComponent(plain, true) as any;
		plainComponent.updateContent(plain);
		const plainLines = renderText(plainComponent);
		assert.ok(
			plainLines.some((line) => line.includes("Thought")),
			`neutral fallback for run without title or duration, got: ${JSON.stringify(plainLines)}`,
		);
		assert.ok(
			!plainLines.some((line) => line.includes("Thinking...")),
			"no loading label fallback",
		);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

function previewMessage(thinking: string) {
	return {
		role: "assistant",
		timestamp: Date.now(),
		content: [{ type: "thinking", thinking }],
	} as unknown as AssistantMessage;
}

test("live thinking keeps a five-row tail window and follows the newest text", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-live-window-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = themeCtx();
	const body = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
	try {
		installCompactThinking(pi, { ...config, liveThinkingLines: 5 });
		emit("session_start", {}, ctx);
		const msg = previewMessage(body);
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});

		const live = new AssistantMessageComponent(msg, true) as any;
		live.updateContent(msg);
		const streaming = renderText(live);
		assert.ok(
			streaming.some((line) => /Thinking/.test(line)),
			`live block keeps the animated heading, got: ${JSON.stringify(streaming)}`,
		);
		assert.deepEqual(
			streaming.filter((line) => /^line-\d+$/.test(line)),
			["line-15", "line-16", "line-17", "line-18", "line-19"],
			"only the newest five rows stay; older rows scroll out of the window",
		);
		assert.ok(
			!streaming.some((line) => line.includes("line-0")),
			"the head has already scrolled out of view",
		);
		assert.ok(
			!streaming.some((line) => /more line/.test(line)),
			"no hidden-line hint while the window follows the stream",
		);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a finished run hides the whole body and only offers the expand hint", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-finished-hide-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = themeCtx();
	const body = Array.from({ length: 2 }, (_, i) => `line-${i}`).join("\n");
	try {
		installCompactThinking(pi, { ...config, liveThinkingLines: 5 });
		emit("session_start", {}, ctx);
		const msg = previewMessage(body);
		const component = new AssistantMessageComponent(msg, true) as any;
		component.updateContent(msg);
		const lines = renderText(component);
		assert.equal(lines.length, 1, `the finished card is a single row: ${JSON.stringify(lines)}`);
		assert.match(lines[0]!, /^Thought · (click to show more|ctrl\+t to expand)$/);
		assert.ok(
			!lines.some((line) => /^line-\d+$/.test(line)),
			"even a short body is hidden once the run ends",
		);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

function thinkingBlockOf(component: any): ThinkingPreviewBlock {
	const block = component.contentContainer?.children?.find(
		(child: unknown) => child instanceof ThinkingPreviewBlock,
	);
	assert.ok(block instanceof ThinkingPreviewBlock, "assistant mounts a thinking preview block");
	return block;
}

test("the finished card expands to the full body and keeps that state across updateContent", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-preview-expand-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = themeCtx();
	const bgSlots: string[] = [];
	(ctx.ui.theme as any).bg = (slot: string, text: string) => {
		bgSlots.push(slot);
		return `<bg>${text}</bg>`;
	};
	const body = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
	try {
		installCompactThinking(pi, { ...config, liveThinkingLines: 5 });
		emit("session_start", {}, ctx);
		const msg = previewMessage(body);
		const component = new AssistantMessageComponent(msg, true) as any;
		component.updateContent(msg);
		const collapsed = renderText(component);
		assert.equal(collapsed.length, 1, "collapsed run is the heading row only");
		assert.ok(
			collapsed.every((line) => !line.includes("<bg>")),
			"collapsed preview is not wrapped in a card",
		);

		const block = thinkingBlockOf(component);
		block.setExpanded(true);
		const rawExpanded = component.render(120) as string[];
		assert.ok(
			rawExpanded.some((line) => line.includes("<bg>")),
			"expanded thinking is wrapped in the success card",
		);
		const expanded = renderText(component);
		assert.ok(!expanded.some((line) => line.includes("more line")));
		assert.ok(expanded.some((line) => line.includes("line-0")));
		assert.ok(expanded.some((line) => line.includes("line-19")));
		assert.equal(
			expanded.filter((line) => /line-\d+/.test(line)).length,
			20,
			"expanded body shows every reasoning row, not just the live window",
		);
		assert.ok(
			bgSlots.includes("toolSuccessBg"),
			"expanded thinking card uses the success background",
		);

		component.updateContent(msg);
		assert.equal(thinkingBlockOf(component).expanded, true);
		assert.ok(renderText(component).some((line) => line.includes("line-0")));

		thinkingBlockOf(component).setExpanded(false);
		const recollapsed = renderText(component);
		assert.equal(recollapsed.length, 1, "collapsing returns to the heading row only");
		assert.match(recollapsed[0]!, /^Thought · /);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the reasoning card replaces Pi's renderer even with hideThinkingBlock off", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-preview-takeover-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = themeCtx();
	const body = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
	try {
		installCompactThinking(pi, { ...config, liveThinkingLines: 5 });
		emit("session_start", {}, ctx);
		const msg = previewMessage(body);
		const component = new AssistantMessageComponent(msg, true) as any;
		// Pi keeps thinking visible by default; the collapsed card must still win.
		component.hideThinkingBlock = false;
		component.updateContent(msg);

		const lines = renderText(component);
		assert.equal(lines.length, 1, `collapsed card replaces Pi's renderer: ${JSON.stringify(lines)}`);
		assert.match(lines[0]!, /^Thought · /);
		assert.ok(!lines.some((line) => /^line-\d+$/.test(line)), "no reasoning rows leak through");
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("liveThinkingLines sizes the streaming window, not the finished card", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-live-lines-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = themeCtx();
	const body = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
	try {
		installCompactThinking(pi, { ...config, liveThinkingLines: 3 });
		emit("session_start", {}, ctx);
		const msg = previewMessage(body);
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		const live = new AssistantMessageComponent(msg, true) as any;
		live.updateContent(msg);
		assert.equal(
			renderText(live).filter((line) => /^line-\d+$/.test(line)).length,
			3,
			"the live window honours liveThinkingLines",
		);

		// A finished run always hides the body, whatever the window size.
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "text_start", contentIndex: 1 },
		});
		const done = new AssistantMessageComponent(msg, true) as any;
		done.updateContent(msg);
		const finished = renderText(done);
		assert.ok(
			finished.some((line) => /^Thought for/.test(line)),
			`finished heading replaces the animation, got: ${JSON.stringify(finished)}`,
		);
		assert.equal(
			finished.filter((line) => /^line-\d+$/.test(line)).length,
			0,
			"the finished card hides the body",
		);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("app.thinking.toggle expands every finished card and collapses them again", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-toggle-all-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const handlers = new Set<(data: string) => any>();
	const setWidgetCalls: unknown[] = [];
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget() {
				setWidgetCalls.push(1);
			},
			requestRender() {},
			onTerminalInput(handler: (data: string) => any) {
				handlers.add(handler);
				return () => handlers.delete(handler);
			},
		},
	} as any;
	const body = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
	const pressCtrlT = () => {
		let consumed = false;
		for (const handler of handlers) {
			if (handler("\x14")?.consume) consumed = true;
		}
		return consumed;
	};
	try {
		installCompactThinking(pi, { ...config, liveThinkingLines: 5 });
		emit("session_start", {}, ctx);
		assert.equal(handlers.size, 1, "session start installs one raw input listener");

		const msg = previewMessage(body);
		const component = new AssistantMessageComponent(msg, true) as any;
		component.updateContent(msg);
		const collapsed = renderText(component);
		assert.equal(collapsed.length, 1, "the finished run shows the heading row only");

		assert.equal(pressCtrlT(), true, "ctrl+t is consumed by the thinking toggle");
		assert.equal(isAllThinkingExpanded(), true);
		const expanded = renderText(new AssistantMessageComponent(msg, true) as any);
		assert.equal(
			expanded.filter((line) => /^line-\d+$/.test(line)).length,
			12,
			"every reasoning row is visible after the toggle",
		);
		assert.ok(!expanded.some((line) => /more line/.test(line)), "no hint while expanded");

		assert.equal(pressCtrlT(), true);
		assert.equal(isAllThinkingExpanded(), false);
		const recollapsed = renderText(new AssistantMessageComponent(msg, true) as any);
		assert.equal(recollapsed.length, 1, "toggling back hides the body again");
	} finally {
		emit("session_shutdown", {}, ctx);
		assert.equal(handlers.size, 0, "shutdown releases the raw input listener");
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ctrl+t leaves keys it does not own and dialogs untouched", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-toggle-guard-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const handlers = new Set<(data: string) => any>();
	let composerFocused = false;
	let tui: any;
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory !== "function") return;
				// 输入框焦点带 getText；对话框/选择器没有，ctrl+t 要放行给它们。
				tui = {
					requestRender() {},
					focusedComponent: composerFocused ? { actionHandlers: new Map() } : {},
				};
				factory(tui, {});
			},
			requestRender() {},
			onTerminalInput(handler: (data: string) => any) {
				handlers.add(handler);
				return () => handlers.delete(handler);
			},
		},
	} as any;
	try {
		installCompactThinking(pi, { ...config, liveThinkingLines: 5 });
		emit("session_start", {}, ctx);
		const handler = [...handlers][0]!;
		assert.equal(handler("a"), undefined, "ordinary typing passes through");
		assert.equal(handler("\x1b[<0;1;1M"), undefined, "mouse packets pass through");
		assert.equal(handler("\x14"), undefined, "dialogs keep their own ctrl+t");
		assert.equal(isAllThinkingExpanded(), false);

		composerFocused = true;
		tui.focusedComponent = { actionHandlers: new Map() };
		assert.deepEqual(handler("\x14"), { consume: true }, "the composer hands ctrl+t over");
		assert.equal(isAllThinkingExpanded(), true);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a live card re-renders after the global toggle, not a stale memo", () => {
	const originalConfig = { ...config };
	const { pi, emit } = runtime();
	const handlers = new Set<(data: string) => any>();
	let tui: any;
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory !== "function") return;
				tui = { requestRender() {}, focusedComponent: { actionHandlers: new Map() } };
				factory(tui, {});
			},
			requestRender() {},
			onTerminalInput(handler: (data: string) => any) {
				handlers.add(handler);
				return () => handlers.delete(handler);
			},
		},
	} as any;
	try {
		installCompactThinking(pi, { ...originalConfig, liveThinkingLines: 5 });
		emit("session_start", {}, ctx);
		const body = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
		const block = new ThinkingPreviewBlock("Thought", body, 0, 11, (text) => text, undefined, 0);
		const collapsed = block.render(80);
		assert.equal(collapsed.length, 1, "the mounted card starts collapsed to its heading");

		for (const handler of handlers) handler("\x14");
		const expanded = block.render(80);
		assert.notStrictEqual(expanded, collapsed, "the toggle invalidates the render memo");
		assert.equal(
			expanded.filter((line) => /^line-\d+$/.test(line.trim())).length,
			20,
			"the same instance now paints the whole body",
		);
	} finally {
		emit("session_shutdown", {}, ctx);
		clearThinkingPreviewCache();
	}
});

test("ctrl+t reaches the thinking toggle through Pi's real input chain", async () => {
	const hostModule = (path: string) =>
		new URL(path, import.meta.resolve("@earendil-works/pi-coding-agent")).href;
	const [{ createInteractiveTui }, { CustomEditor }, { getEditorTheme }, { KeybindingsManager }] =
		await Promise.all([
			import(hostModule("./modes/interactive/tui-renderer.js")),
			import(hostModule("./modes/interactive/components/custom-editor.js")),
			import(hostModule("./modes/interactive/theme/theme.js")),
			import(hostModule("./core/keybindings.js")),
		]);
	const { Container, setKeybindings } = await import("@earendil-works/pi-tui");
	const bindings = new KeybindingsManager();
	setKeybindings(bindings);
	const terminal: any = {
		columns: 80,
		rows: 20,
		isTTY: true,
		write() {},
		onData: () => () => {},
		setRawMode() {},
		getColorMode: () => "truecolor",
		start() {},
		stop() {},
		showCursor() {},
		hideCursor() {},
	};
	const renderer: any = createInteractiveTui({
		tuiMode: "regular",
		showHardwareCursor: false,
		logDirectory: tmpdir(),
		terminal,
	});
	renderer.requestRender = () => {};
	const root = new Container();
	renderer.addChild(root);
	const editor = new CustomEditor(renderer, getEditorTheme(), bindings, {
		embedWorkingStatus: true,
	});
	root.addChild(editor);
	renderer.setFocus(editor);

	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-real-input-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	let piToggleCalls = 0;
	editor.onAction("app.thinking.toggle", () => {
		piToggleCalls += 1;
	});
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget() {},
			requestRender() {},
			onTerminalInput(handler: (data: string) => any) {
				return renderer.addInputListener(handler);
			},
		},
	} as any;
	try {
		installCompactThinking(pi, { ...config, liveThinkingLines: 5 });
		emit("session_start", {}, ctx);
		const body = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
		const block = new ThinkingPreviewBlock("Thought", body, 0, 21, (text) => text, undefined, 0);
		assert.equal(block.expanded, false);

		renderer.handleTerminalInput("\x14");
		assert.equal(block.expanded, true, "the real chain expands finished thinking");
		assert.equal(piToggleCalls, 0, "Pi's own toggle never sees the consumed key");

		renderer.handleTerminalInput("\x14");
		assert.equal(block.expanded, false, "a second press collapses again");
		assert.equal(piToggleCalls, 0);
	} finally {
		emit("session_shutdown", {}, ctx);
		renderer.stop();
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * `/reload` 真实顺序：旧 runner 先 session_shutdown，模块以 moduleCache:false 重新求值，
 * 新 runner 再 session_start。这里用两个独立 install 模拟两个模块实例。
 */
test("reload releases the old ctrl+t listener and keeps the new one working", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-reload-listener-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const listeners = new Set<(data: string) => any>();
	let tui: any;
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory !== "function") return;
				tui = { requestRender() {}, focusedComponent: { actionHandlers: new Map() } };
				factory(tui, {});
			},
			requestRender() {},
			onTerminalInput(handler: (data: string) => any) {
				listeners.add(handler);
				// 与 Pi 的 addExtensionTerminalInputListener 一致：返回退订函数。
				return () => listeners.delete(handler);
			},
		},
	} as any;
	const first = runtime();
	const second = runtime();
	const body = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
	const msg = previewMessage(body);
	const isExpanded = () => thinkingBlockOf(
		(() => {
			const component = new AssistantMessageComponent(msg, true) as any;
			component.updateContent(msg);
			return component;
		})(),
	).expanded;
	try {
		installCompactThinking(first.pi, { ...config, liveThinkingLines: 5 });
		first.emit("session_start", {}, ctx);
		assert.equal(listeners.size, 1, "the old module installs one listener");

		// 旧模块先收到 shutdown：它的监听必须撤掉，不留悬空闭包。
		first.emit("session_shutdown", { reason: "reload" }, ctx);
		assert.equal(listeners.size, 0, "reload releases the old raw-input listener");

		// 新模块实例接管。
		installCompactThinking(second.pi, { ...config, liveThinkingLines: 5 });
		second.emit("session_start", { reason: "reload" }, ctx);
		assert.equal(listeners.size, 1, "the new module installs its own single listener");

		// 只剩一个监听 ⇒ 一次 ctrl+t 只翻转一次状态（重复注册会翻转两次 = 无变化）。
		assert.equal(isExpanded(), false, "cards start collapsed after reload");
		second.emit("session_start", { reason: "reload" }, ctx);
		assert.equal(
			listeners.size,
			1,
			"a second session_start on the same instance replaces, not stacks, the listener",
		);
		for (const listener of listeners) listener("\x14");
		assert.equal(isExpanded(), true, "one ctrl+t expands the cards exactly once");
	} finally {
		second.emit("session_shutdown", { reason: "quit" }, ctx);
		assert.equal(listeners.size, 0, "shutdown releases the listener");
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reload clears the global expand state instead of leaking it into the next session", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-reload-state-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const listeners = new Set<(data: string) => any>();
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory !== "function") return;
				factory({ requestRender() {}, focusedComponent: { actionHandlers: new Map() } }, {});
			},
			requestRender() {},
			onTerminalInput(handler: (data: string) => any) {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
		},
	} as any;
	const { pi, emit } = runtime();
	const body = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
	try {
		installCompactThinking(pi, { ...config, liveThinkingLines: 5 });
		emit("session_start", {}, ctx);
		for (const listener of listeners) listener("\x14");
		assert.equal(isAllThinkingExpanded(), true, "the session expanded its cards");

		emit("session_shutdown", { reason: "reload" }, ctx);
		assert.equal(
			isAllThinkingExpanded(),
			false,
			"the next module instance must not start expanded",
		);

		// reload 后的新实例重建卡片：默认收起，不会继承上一会话的展开态。
		const next = runtime();
		installCompactThinking(next.pi, { ...config, liveThinkingLines: 5 });
		next.emit("session_start", { reason: "reload" }, ctx);
		const msg = previewMessage(body);
		const component = new AssistantMessageComponent(msg, true) as any;
		component.updateContent(msg);
		const lines = renderText(component);
		assert.equal(lines.length, 1, `rebuilt cards start collapsed: ${JSON.stringify(lines)}`);
		next.emit("session_shutdown", { reason: "quit" }, ctx);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reload keeps mounted cards live: ctrl+t still repaints them on screen", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-reload-mounted-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const listeners = new Set<(data: string) => any>();
	// 模拟 Pi 的聊天容器：refreshMountedTranscript 从 getMountedRoots 扫到卡片。
	const mounted: any[] = [];
	const tui: any = {
		requestRender() {},
		focusedComponent: { actionHandlers: new Map() },
		getMountedRoots: () => mounted,
		children: mounted,
	};
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") factory(tui, {});
			},
			requestRender() {},
			onTerminalInput(handler: (data: string) => any) {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
		},
	} as any;
	const body = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
	const pressCtrlT = () => {
		for (const listener of listeners) listener("\x14");
	};
	try {
		const first = runtime();
		installCompactThinking(first.pi, { ...config, liveThinkingLines: 5 });
		first.emit("session_start", {}, ctx);

		// reload 前挂进容器的卡片（Pi 的 rebuildChatFromMessages 会用原始原型重建它们）。
		const msg = previewMessage(body);
		const before = new AssistantMessageComponent(msg, true) as any;
		before.updateContent(msg);
		mounted.push(before);

		first.emit("session_shutdown", { reason: "reload" }, ctx);
		assert.equal(listeners.size, 0, "reload drops the old listener");

		// 新模块实例 + reload 的 session_start：refreshMountedTranscript 重绘已挂载卡片。
		const second = runtime();
		installCompactThinking(second.pi, { ...config, liveThinkingLines: 5 });
		second.emit("session_start", { reason: "reload" }, ctx);
		assert.equal(listeners.size, 1, "exactly one listener after reload");

		assert.equal(
			renderText(before).length,
			1,
			"the already-mounted card is collapsed again after the reload repaint",
		);

		pressCtrlT();
		const expanded = renderText(before);
		assert.equal(
			expanded.filter((line) => /^line-\d+$/.test(line)).length,
			12,
			`ctrl+t repaints the mounted card after reload: ${JSON.stringify(expanded)}`,
		);

		pressCtrlT();
		assert.equal(renderText(before).length, 1, "and collapses it again");
		second.emit("session_shutdown", { reason: "quit" }, ctx);
	} finally {
		mounted.length = 0;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * `/reload` 的真实顺序与最小模拟不同：InteractiveMode.handleReloadCommand 先调
 * resetExtensionUI()（clearExtensionTerminalInputListeners 一次性清掉所有扩展监听），
 * 之后旧 runner 才发 session_shutdown。所以旧实例的退订发生在已清空之后，
 * 必须是幂等的，且不能碰新实例的监听。
 */
test("reload order (clear listeners first, then shutdown) leaves exactly one working listener", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-reload-order-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	// 复刻 Pi 的订阅表：退订函数可被重复调用，且只移除自己那一项。
	const subscriptions = new Set<{ handler: (d: string) => any }>();
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function")
					factory({ requestRender() {}, focusedComponent: { actionHandlers: new Map() } }, {});
			},
			requestRender() {},
			onTerminalInput(handler: (data: string) => any) {
				const subscription = { handler };
				subscriptions.add(subscription);
				return () => subscriptions.delete(subscription);
			},
		},
	} as any;
	// Pi 的 clearExtensionTerminalInputListeners()：全部退订并清空。
	const clearListeners = () => {
		for (const subscription of subscriptions) subscriptions.delete(subscription);
	};
	const pressCtrlT = () => {
		for (const subscription of subscriptions) subscription.handler("\x14");
	};
	const body = Array.from({ length: 12 }, (_, i) => `line-${i}`).join("\n");
	const expandedCount = (component: any) =>
		renderText(component).filter((line) => /^line-\d+$/.test(line)).length;
	try {
		const first = runtime();
		installCompactThinking(first.pi, { ...config, liveThinkingLines: 5 });
		first.emit("session_start", {}, ctx);
		assert.equal(subscriptions.size, 1, "first install registers one listener");

		// --- 真实 reload 顺序 ---
		clearListeners();
		assert.equal(subscriptions.size, 0, "resetExtensionUI cleared every extension listener");
		// 旧实例现在才收到 shutdown，它的退订必须对已清空的表无副作用。
		first.emit("session_shutdown", { reason: "reload" }, ctx);
		assert.equal(subscriptions.size, 0, "stale unsubscribe is a no-op on the cleared table");

		const second = runtime();
		installCompactThinking(second.pi, { ...config, liveThinkingLines: 5 });
		second.emit("session_start", { reason: "reload" }, ctx);
		assert.equal(subscriptions.size, 1, "the new module owns exactly one listener");

		// 一次 ctrl+t 只翻转一次：若旧实例的监听复活或重复注册，这里会翻转两次。
		const msg = previewMessage(body);
		const component = new AssistantMessageComponent(msg, true) as any;
		component.updateContent(msg);
		assert.equal(expandedCount(component), 0, "starts collapsed");
		pressCtrlT();
		assert.equal(expandedCount(component), 12, "one press expands exactly once");
		pressCtrlT();
		assert.equal(expandedCount(component), 0, "one press collapses exactly once");

		second.emit("session_shutdown", { reason: "quit" }, ctx);
		assert.equal(subscriptions.size, 0, "shutdown releases the listener");
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * 有的 provider（实测 flash-models）在流式期间不吐 reasoning：thinking 内容一直是
 * 空字符串，只在消息结束时才给全文。这种模型运行中只能看到标题行，这是 provider
 * 的行为，不是渲染丢了内容。此测试锁住：空内容时只显示标题、不崩、留出正文位置。
 */
test("a provider that streams no reasoning shows the heading only, then hides on finish", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-empty-reasoning-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = themeCtx();
	try {
		installCompactThinking(pi, { ...config, liveThinkingLines: 5 });
		emit("session_start", {}, ctx);
		// 流式期间 thinking 为空（flash-models 的 reasoning_content 就是这种）。
		const emptyPartial = {
			role: "assistant",
			timestamp: Date.now(),
			content: [{ type: "thinking", thinking: "" }],
		} as unknown as AssistantMessage;
		emit("message_update", {
			message: emptyPartial,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		const live = new AssistantMessageComponent(emptyPartial, true) as any;
		live.updateContent(emptyPartial);
		const streaming = renderText(live);
		assert.ok(
			streaming.some((line) => /Thinking/.test(line)),
			`empty reasoning still shows the animated heading: ${JSON.stringify(streaming)}`,
		);
		assert.equal(
			streaming.filter((line) => /^reason-/.test(line)).length,
			0,
			"no body rows exist to draw",
		);

		// 收尾：正文仍为空。空的、非活动的思考块整条跳过，不占屏幕、也不留空行
		// （否则每个没有 reasoning 的 provider 都会在 transcript 里留一条空洞）。
		emit("message_update", {
			message: emptyPartial,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});
		const done = new AssistantMessageComponent(emptyPartial, true) as any;
		done.updateContent(emptyPartial);
		assert.deepEqual(
			renderText(done),
			[],
			"an empty finished thinking block draws nothing",
		);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});
