// escCloseHitbox 的契约：
// [esc] 按钮位于弹框标题行（box 第 2 行）右端，5 列宽；
// bounds 为 0-based 的弹框起点（left/top）+ 宽度。
import assert from "node:assert/strict";
import test from "node:test";
import { formatSkillsForPrompt, initTheme } from "@earendil-works/pi-coding-agent";
import { rgbColor } from "@earendil-works/pi-tui";
import {
	capParts,
	collectContextBreakdown,
	copyButtonHitbox,
	escCloseHitbox,
	hasActiveTextPreview,
	resolveUsedTokens,
	setPreviewCopyImpl,
	showTextPreview,
} from "../extensions/feature/context.ts";

initTheme("dark");

test("context breakdown separates tools, results, and conversation without inflating estimates", () => {
	const ctx = {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			contextFiles: [{ path: "AGENTS.md", content: "cccc" }],
			skills: [
				{ name: "ok", description: "desc", filePath: "/v" },
				{
					name: "hidden",
					description: "x".repeat(100),
					filePath: "/hidden",
					disableModelInvocation: true,
				},
			],
		}),
		getSystemPrompt: () => "s".repeat(200),
		sessionManager: {
			buildSessionProjection: () => ({
				entries: [
					{
						sourceEntry: { type: "message" },
						messages: [
							{
								role: "system",
								content: "",
								sections: { preamble: "s".repeat(200) },
							},
							{ role: "user", content: "uuuuuuuu", timestamp: 0 },
							{
								role: "assistant",
								content: [
									{ type: "text", text: "aaaa" },
									{ type: "toolCall", id: "1", name: "read", arguments: { path: "a" } },
								],
							},
							{
								role: "toolResult",
								toolCallId: "1",
								toolName: "read",
								content: "rrrrrrrr",
								timestamp: 0,
							},
						],
					},
					{
						sourceEntry: { type: "compaction" },
						messages: [{ role: "compactionSummary", summary: "ssss", timestamp: 0 }],
					},
				],
			}),
		},
	} as any;
	const tools = [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object" },
			promptGuidelines: [],
			sourceInfo: {},
		},
	] as any;

	const breakdown = collectContextBreakdown(ctx, tools);
	const parts = breakdown.parts;
	assert.deepEqual(
		parts.map(({ label, color }) => [label, color]),
		[
			["System prompt", rgbColor(0x79, 0xc0, 0xff)],
			["Memory", rgbColor(0xff, 0x7b, 0x72)],
			["Skills", rgbColor(0xcb, 0x92, 0x14)],
			["Tools definition", rgbColor(0x37, 0xb3, 0x4a)],
			["Tool results", rgbColor(0xf7, 0x78, 0xba)],
			["Context", rgbColor(0xf0, 0x88, 0x3e)],
		],
	);
	assert.equal(parts.find((part) => part.label === "System prompt")?.tokens, 50);
	assert.equal(parts.find((part) => part.label === "Memory")?.tokens, 0);
	assert.equal(parts.find((part) => part.label === "Skills")?.tokens, 0);
	assert.match(breakdown.previews.memoryFiles, /## AGENTS\.md/);
	assert.match(breakdown.previews.memoryFiles, /cccc/);
	assert.match(breakdown.previews.skills, /<name>ok<\/name>/);
	assert.doesNotMatch(breakdown.previews.skills, /hidden/);
	assert.equal(parts.find((part) => part.label === "Tool results")?.tokens, 2);
	assert.equal(parts.find((part) => part.label === "Context")?.tokens, 8);
	assert.match(breakdown.previews.systemPrompt, /"preamble": "s{200}"/);
	assert.match(breakdown.previews.tools, /Definition: read/);
	assert.match(breakdown.previews.tools, /"parameters"/);
	assert.doesNotMatch(breakdown.previews.tools, /Call: read/);
	assert.match(breakdown.previews.toolResults, /Result: read/);
	assert.match(breakdown.previews.toolResults, /rrrrrrrr/);
	assert.match(breakdown.previews.contextFiles, /uuuuuuuu/);
	assert.match(breakdown.previews.contextFiles, /aaaa/);
	assert.match(breakdown.previews.contextFiles, /Assistant tool call: read/);
	assert.match(breakdown.previews.contextFiles, /"path": "a"/);
	assert.match(breakdown.previews.contextFiles, /compactionSummary/);

	const fitted = capParts(parts, parts.reduce((sum, part) => sum + part.tokens, 0) + 10);
	assert.deepEqual(fitted, parts, "estimates are not inflated to fill provider usage");
	const fixedTokens = parts.slice(0, 4).reduce((sum, part) => sum + part.tokens, 0);
	const capped = capParts(parts, fixedTokens + 5, 4);
	assert.deepEqual(
		capped.slice(0, 4),
		parts.slice(0, 4),
		"system prompt, memory, skills and tools definition stay stable",
	);
	assert.equal(
		capped.reduce((sum, part) => sum + part.tokens, 0),
		fixedTokens + 5,
	);
	const finalParts = [
		...fitted,
		{ label: "Other", tokens: 10, color: rgbColor(0x92, 0x9e, 0xab) },
		{ label: "Free space", tokens: 100, color: rgbColor(0x76, 0x84, 0x94) },
	];
	assert.equal(new Set(finalParts.map((part) => part.color)).size, 8);
});

test("context breakdown attributes embedded memory and skills once", () => {
	const memory = "cccc";
	const skills = [{ name: "ok", description: "desc", filePath: "/v" }];
	const skillsText = formatSkillsForPrompt(skills as any).trim();
	const chunk = `<project_instructions path="AGENTS.md">\n${memory}\n</project_instructions>`;
	const ctx = {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: [],
			contextFiles: [{ path: "AGENTS.md", content: memory }],
			skills,
		}),
		sessionManager: {
			buildSessionProjection: () => ({
				entries: [
					{
						sourceEntry: { type: "message" },
						messages: [
							{
								role: "system",
								content: "",
								sections: {
									preamble: "base",
									project_context: `<project_context>\n${chunk}\n</project_context>`,
									skills: `<skills>\n${skillsText}\n</skills>`,
								},
							},
						],
					},
				],
			}),
		},
	} as any;

	const breakdown = collectContextBreakdown(ctx, []);
	const systemTokens = breakdown.parts.find((part) => part.label === "System prompt")?.tokens ?? -1;
	const memoryTokens = breakdown.parts.find((part) => part.label === "Memory")?.tokens ?? -1;
	const skillsTokens = breakdown.parts.find((part) => part.label === "Skills")?.tokens ?? -1;
	assert.equal(memoryTokens, Math.ceil(chunk.length / 4));
	assert.equal(skillsTokens, Math.ceil(skillsText.length / 4));
	const sectionsText = [
		"base",
		`<project_context>\n${chunk}\n</project_context>`,
		`<skills>\n${skillsText}\n</skills>`,
	].join("");
	assert.equal(systemTokens + memoryTokens + skillsTokens, Math.ceil(sectionsText.length / 4));
	assert.ok(systemTokens < Math.ceil(sectionsText.length / 4));
});

test("context breakdown counts tool schemas once", () => {
	const definition = {
		name: "read",
		description: "Read a file",
		parameters: { type: "object" },
	};
	const removed = {
		name: "bash",
		description: "x".repeat(400),
		parameters: { type: "object" },
	};
	const ctx = {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: ["read"],
		}),
		sessionManager: {
			buildSessionProjection: () => ({
				entries: [
					{
						sourceEntry: { type: "message" },
						messages: [
							{
								role: "system",
								content: "base",
								toolsAdded: [definition],
								toolsRemoved: [removed],
							},
						],
					},
				],
			}),
		},
	} as any;
	const tools = [{ ...definition, promptGuidelines: [], sourceInfo: {} }] as any;

	const breakdown = collectContextBreakdown(ctx, tools);
	const systemTokens = breakdown.parts.find((part) => part.label === "System prompt")?.tokens;
	const toolTokens = breakdown.parts.find((part) => part.label === "Tools definition")?.tokens;
	assert.equal(systemTokens, Math.ceil("base".length / 4));
	assert.equal(toolTokens, Math.ceil(JSON.stringify(definition).length / 4));
	assert.equal(
		(systemTokens ?? 0) + (toolTokens ?? 0),
		Math.ceil("base".length / 4) + Math.ceil(JSON.stringify(definition).length / 4),
	);
});

test("resolveUsedTokens rejects inconsistent or implausibly small provider usage", () => {
	assert.equal(resolveUsedTokens({ tokens: 1, percent: 7 }, 20_000, 272_000), 19_040);
	assert.equal(resolveUsedTokens({ tokens: 19_000, percent: 7 }, 20_000, 272_000), 19_000);
	assert.equal(resolveUsedTokens({ tokens: 1, percent: 1 / 2_720 }, 20_000, 272_000), 20_000);
	assert.equal(resolveUsedTokens({ tokens: null, percent: null }, 20_000, 272_000), 20_000);
});

test("capParts never produces negative tokens when estimates exceed usage", () => {
	const parts = Array.from({ length: 8 }, (_, index) => ({
		label: String(index),
		tokens: 1,
		color: rgbColor(0x76, 0x84, 0x94),
	}));
	const fitted = capParts(parts, 5);
	assert.equal(
		fitted.reduce((sum, part) => sum + part.tokens, 0),
		5,
	);
	assert.ok(fitted.every((part) => part.tokens >= 0));
});

test("copyButtonHitbox sits one space left of [esc] on the title row", () => {
	assert.deepEqual(copyButtonHitbox({ left: 8, top: 1, width: 64 }), {
		row: 3,
		startCol: 60,
		endCol: 65,
	});
	const esc = escCloseHitbox({ left: 8, top: 1, width: 64 });
	const copy = copyButtonHitbox({ left: 8, top: 1, width: 64 });
	assert.equal(copy.row, esc.row);
	assert.ok(copy.endCol < esc.startCol);
});

test("escCloseHitbox sits 5 columns wide at the title row's right edge", () => {
	assert.deepEqual(escCloseHitbox({ left: 8, top: 1, width: 64 }), {
		row: 3,
		startCol: 67,
		endCol: 71,
	});
	assert.deepEqual(escCloseHitbox({ left: 1, top: 1, width: 38 }), {
		row: 3,
		startCol: 34,
		endCol: 38,
	});
	assert.deepEqual(escCloseHitbox({ left: 20, top: 6, width: 50 }), {
		row: 8,
		startCol: 65,
		endCol: 69,
	});
});

/** showTextPreview 自定义 UI 的最小 harness：捕获 component，theme 可注入，可选挂载回调。 */
/** showTextPreview 自定义 UI 的最小 harness：捕获 component（挂载后实时可读），theme 可注入，可选挂载回调。 */
function textPreviewHarness(
	theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text },
	onMount?: (component: any) => void,
	tui: any = { terminal: { columns: 80, rows: 24 }, requestRender() {} },
): any {
	let component: any;
	return {
		custom: async (factory: any) =>
			await new Promise<void>((resolve) => {
				component = factory(tui, theme, null, resolve);
				onMount?.(component);
			}),
		get component() {
			return component;
		},
	};
}

test("showTextPreview closes from a regular-mode SGR click without overlay layout", async () => {
	const tui = { terminal: { columns: 80, rows: 24 }, requestRender() {} };
	const ui = textPreviewHarness(undefined, (c) => c.render(64), tui);
	const preview = showTextPreview({ ui } as any, "Output", "hello");
	// margin 2、80x24、宽 64、高 19：起点 col=8 row=2。局部 [esc] (60,1) → 屏幕 69,4。
	ui.component.handleInput("\x1b[<0;69;4M");
	await preview;
	assert.equal(hasActiveTextPreview(), false);
});

test("showTextPreview closes from a regular-mode SGR click on [esc]", async () => {
	const tui = {
		terminal: { columns: 80, rows: 24 },
		requestRender() {},
		renderedOverlayLayouts: [{ col: 0, row: 0, width: 64, height: 20 }],
	};
	const ui = textPreviewHarness(undefined, (c) => c.render(64), tui);
	const preview = showTextPreview({ ui } as any, "Output", "hello");
	// 局部 x=60 是 [esc]；SGR 是 1-based 屏幕坐标，overlay 在 0,0 时 col=61 row=2。
	ui.component.handleInput("\x1b[<0;61;2M");
	await preview;
	assert.equal(hasActiveTextPreview(), false);
});

test("showTextPreview uses the overlay under the pointer when several are stacked", async () => {
	const tui: any = {
		terminal: { columns: 80, rows: 24 },
		requestRender() {},
	};
	const ui = textPreviewHarness(
		undefined,
		(c) => {
			// 最上层是另一个弹框；预览在下层，起点 col=10。取最上层会把点击算偏。
			tui.focusedComponent = c;
			tui.renderedOverlayLayouts = [
				{ col: 10, row: 0, width: 64, height: 20, entry: { component: c } },
				{ col: 0, row: 0, width: 80, height: 24, entry: { component: {} } },
			];
			c.render(64);
		},
		tui,
	);
	const preview = showTextPreview({ ui } as any, "Output", "hello");
	// 局部 x=60 是 [esc]；下层起点 col=10，屏幕 col=71。
	ui.component.handleInput("\x1b[<0;71;2M");
	await preview;
	assert.equal(hasActiveTextPreview(), false);
});

test("showTextPreview highlights and closes from the [esc] mouse hitbox", async () => {
	let escColor = "";
	const ui = textPreviewHarness(
		{
			fg: (color: string, text: string) => {
				if (text === "[esc]") escColor = color;
				return text;
			},
			bold: (text: string) => text,
		},
		(c) => c.render(64),
	);
	const preview = showTextPreview({ ui } as any, "Output", "hello");
	assert.equal(hasActiveTextPreview(), true);
	assert.equal(escColor, "muted");
	// handleMouse 用弹框局部 0-based 坐标：title 第 1 行，[esc] 在行尾 col=58..62。
	ui.component.handleMouse({ type: "move", x: 60, y: 1, button: "none" });
	ui.component.render(64);
	assert.equal(escColor, "text", "[esc] hover switches to text color");
	ui.component.handleMouse({ type: "press", x: 60, y: 1, button: "left" });
	await preview;
	assert.equal(hasActiveTextPreview(), false);
});

test("showTextPreview copies content from the [copy] hitbox and flashes confirmation", async () => {
	const flashes: string[] = [];
	const copied: string[] = [];
	setPreviewCopyImpl(async (text) => {
		copied.push(text);
	});
	let copyColor = "";
	const theme = {
		fg: (color: string, text: string) => {
			if (text === "[copy]") copyColor = color;
			return text;
		},
		bold: (text: string) => text,
	};
	const ui = textPreviewHarness(theme, (c) => c.render(64), {
		terminal: { columns: 80, rows: 24 },
		requestRender() {},
		flash: (message: string) => flashes.push(message),
	});
	try {
		const preview = showTextPreview({ ui } as any, "Output", "hello preview");
		assert.equal(copyColor, "muted");
		// [copy] 命中 title 行 col=51..56（esc 左侧）。
		ui.component.handleMouse({ type: "move", x: 53, y: 1, button: "none" });
		ui.component.render(64);
		assert.equal(copyColor, "text", "[copy] hover switches to text color");
		ui.component.handleMouse({ type: "press", x: 53, y: 1, button: "left" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(copied, ["hello preview"]);
		assert.deepEqual(flashes, ["Copied!"]);
		assert.equal(hasActiveTextPreview(), true, "复制不关闭预览");
		ui.component.handleInput("\x1b");
		await preview;
	} finally {
		setPreviewCopyImpl(null);
	}
});

test("showTextPreview scrollbar supports press and drag", async () => {
	const ui = textPreviewHarness();
	const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
	const preview = showTextPreview({ ui } as any, "Output", content);
	const initial = ui.component.render(64).join("\n");
	assert.match(initial, /1-13 \/ 100 lines/);
	// 滚动条局部坐标：col=62（右 border 内侧），body track row=3..；从顶部 thumb 拖到底部。
	ui.component.handleMouse({ type: "press", x: 62, y: 5, button: "left" });
	ui.component.handleMouse({ type: "drag", x: 62, y: 15, button: "left" });
	ui.component.handleMouse({ type: "release", x: 62, y: 15, button: "left" });
	const dragged = ui.component.render(64).join("\n");
	assert.match(dragged, /88-100 \/ 100 lines/);
	ui.component.handleInput("\x1b");
	await preview;
});
