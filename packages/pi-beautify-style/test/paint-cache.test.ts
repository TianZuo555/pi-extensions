import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import {
	config,
} from "../extensions/config/config.ts";
import { installCompactMode } from "../extensions/renderer/compact-mode.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { setHoveredToolCallId } from "../extensions/renderer/mouse/hover.ts";
import {
	getMessageDisplayTheme,
	setMessageDisplayTheme,
} from "../extensions/renderer/tool/message-display.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/index.ts";
import { createCcstyleTool } from "../extensions/renderer/tool/ccstyle-tool.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

initTheme("dark");

test("ccstyle call paint cache stores the truncated line, so a hit stays in width", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const theme = { fg: (_color: string, text: string) => text } as any;
	try {
		const tool = createCcstyleTool(
			{ name: "ask_user", label: "ask_user" },
			new WriteExecutionMetadataStore(),
			"ask_user",
		);
		const answers = Array.from({ length: 12 }, (_, index) => ({
			questionIndex: index,
			question: `q${index}`,
			kind: "option",
			answer: "x",
		}));
		const ctx = {
			state: {},
			toolCallId: "paint-cache-call",
			isPartial: false,
			executionStarted: false,
			result: { details: { answers } },
		} as any;
		const call = tool.renderCall({ questions: [] }, theme, ctx);
		for (let width = 1; width <= 40; width++) {
			const first = call.render(width);
			const second = call.render(width);
			assert.deepEqual(
				second,
				first,
				`width ${width}: a cache hit must return the same truncated line`,
			);
			for (const line of [...first, ...second]) {
				assert.ok(
					visibleWidth(line) <= width,
					`width ${width}: rendered line is ${visibleWidth(line)} columns`,
				);
			}
		}
	} finally {
		config.mode = previousMode;
	}
});

test("ccstyle tool paint cache reuses lines until content or hover changes", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const tool = new ToolExecutionComponent(
			"read",
			"paint-cache-read",
			{ path: "a.ts" },
			{},
			undefined,
			{ theme: {}, requestRender() {}, setStatus() {} } as any,
			process.cwd(),
		) as any;
		tool.updateResult({
			content: [{ type: "text", text: "hello\nworld" }],
			isError: false,
		});
		const first = tool.render(80);
		assert.equal(tool.render(80), first, "unchanged paint returns the same lines array");
		setHoveredToolCallId("paint-cache-read");
		const hovered = tool.render(80);
		assert.notEqual(hovered, first, "hover fingerprint misses the cache");
		setHoveredToolCallId(null);
		tool.invalidate();
		const afterInvalidate = tool.render(80);
		assert.notEqual(afterInvalidate, first, "invalidate drops the cached paint");
		assert.deepEqual(afterInvalidate, first);
	} finally {
		setHoveredToolCallId(null);
		config.mode = previousMode;
		hooks.shutdown();
	}
});

test("compact edit/write paint cache reuses lines until hover changes", () => {
	const previousMode = config.mode;
	const previousTheme = getMessageDisplayTheme();
	config.mode = "compact";
	setMessageDisplayTheme({
		fg: (_color: string, text: string) => text,
		italic: (text: string) => text,
		bold: (text: string) => text,
	});
	const store = new WriteExecutionMetadataStore();
	const compact = installCompactMode({ writeMetadata: store });
	try {
		const write = new ToolExecutionComponent(
			"write",
			"compact-paint-write",
			{ path: "a.ts", content: "x\n" },
			{},
			undefined,
			{ theme: {}, requestRender() {}, setStatus() {} } as any,
			process.cwd(),
		) as any;
		store.set("compact-paint-write", { fileExistedBeforeWrite: false });
		write.updateResult({
			content: [{ type: "text", text: "ok" }],
			isError: false,
		});
		const first = write.render(80);
		assert.equal(write.render(80), first, "unchanged compact write paint is reused");
		setHoveredToolCallId("compact-paint-write");
		assert.notEqual(write.render(80), first, "compact write hover misses the cache");
	} finally {
		setHoveredToolCallId(null);
		setMessageDisplayTheme(previousTheme);
		config.mode = previousMode;
		compact.shutdown();
	}
});
