import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	config,
} from "../extensions/config/config.ts";
import {
	FOOTER_NERD_ICON_CACHE,
	FOOTER_NERD_ICON_GIT,
	FOOTER_NERD_ICON_MCP,
	applyCustomFooter,
	indentFooterLine,
	clearCustomFooter,
	clipFooterLabel,
	colorGitStatus,
	footerGlyphs,
	formatXaiFooterChip,
	modelChip,
	parseGitStats,
} from "../extensions/feature/shell/footer.ts";
import {
	FOOTER_GIT_KEY,
	FOOTER_LINE1_KEYS,
	FOOTER_LINE2_KEYS,
	isBuiltinFooterKey,
	isSkippedFooterStatusKey,
	PI_USAGE_KEY,
	footerLine3Keys,
	visibleFooterPluginTexts,
} from "../extensions/feature/shell/footer-layout.ts";

test("model chip joins effort with a circle instead of a separator dot", () => {
	const theme = {
		fg: (color: string, text: string) => `{${color}}${text}{/}`,
	};
	const color = (text: string) => `{think}${text}{/}`;
	assert.equal(
		modelChip(theme, "claude-sonnet", "high", color),
		"{accent}claude-sonnet{/} {think}\u25d5 high{/}",
	);
	assert.equal(modelChip(theme, "claude-sonnet", "off", color), "{accent}claude-sonnet{/}");
});

test("git status symbols take a color by role", () => {
	const theme = {
		fg: (color: string, text: string) => `{${color}}${text}{/}`,
	};
	assert.equal(
		colorGitStatus(theme, "=!\u21e12\u21e33"),
		"{error}={/}{warning}!{/}{success}\u21e1{/}{success}2{/}{error}\u21e3{/}{error}3{/}",
	);
	assert.equal(colorGitStatus(theme, "?"), "{muted}?{/}");
});

test("footerGlyphs drops Nerd Font icons when disabled", () => {
	assert.deepEqual(footerGlyphs(true), {
		git: FOOTER_NERD_ICON_GIT,
		cache: FOOTER_NERD_ICON_CACHE,
		mcp: FOOTER_NERD_ICON_MCP,
	});
	assert.deepEqual(footerGlyphs(false), { git: "", cache: "", mcp: "" });
});

test("line1 holds the builtin stats and line2 holds the location chips", () => {
	assert.deepEqual([...FOOTER_LINE1_KEYS], ["model", "context", "cache", "rate", "cost"]);
	assert.deepEqual([...FOOTER_LINE2_KEYS], ["cwd", "git"]);
	assert.equal(isBuiltinFooterKey(FOOTER_GIT_KEY), true);
	assert.equal(isBuiltinFooterKey(PI_USAGE_KEY), false);
	assert.equal(isSkippedFooterStatusKey("model"), true);
});

test("disabled custom footer leaves another extension's footer untouched", () => {
	const previous = { ...config };
	const calls: unknown[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			setFooter: (factory: unknown) => calls.push(factory),
		},
	};

	try {
		Object.assign(config, { enableCustomFooter: false });
		applyCustomFooter(ctx as never);
		assert.deepEqual(calls, []);

		clearCustomFooter(ctx as never);
		assert.deepEqual(calls, [undefined]);
	} finally {
		Object.assign(config, previous);
	}
});

test("footerLine3Keys sends every plugin status to line 3 in alpha order", () => {
	const texts = new Map([
		["ponytail", "\u26a1 FULL"],
		["usage", "codex 5%"],
		["model", "should be skipped"],
		["lsp", "2 errors"],
		["cloud-quota", "80%"],
	]);
	assert.deepEqual(footerLine3Keys([], texts), ["cloud-quota", "lsp", "ponytail", "usage"]);
});

test("footerLine3Keys drops hidden, empty, and builtin keys", () => {
	const texts = new Map([
		["ponytail", "\u26a1 FULL"],
		["lsp", "   "],
		[FOOTER_GIT_KEY, "main"],
		["model", "ignored"],
	]);
	assert.deepEqual(footerLine3Keys([], texts), ["ponytail"]);
	assert.deepEqual(footerLine3Keys(["ponytail"], texts), []);
});

test("visibleFooterPluginTexts skips empty text and keeps the given order", () => {
	const texts = new Map([
		["usage", "codex 5%"],
		[PI_USAGE_KEY, "xAI 14%"],
		["ponytail", "\u26a1 FULL"],
		["lsp", ""],
	]);
	assert.deepEqual(visibleFooterPluginTexts([PI_USAGE_KEY, "usage", "ghost"], texts), [
		"xAI 14%",
		"codex 5%",
	]);
	assert.deepEqual(visibleFooterPluginTexts(["ponytail", "lsp"], texts), ["\u26a1 FULL"]);
});

test("clipFooterLabel keeps the head and ends in wide ellipsis, and 0 disables the cap", () => {
	assert.equal(clipFooterLabel("main", 16), "main");
	assert.equal(clipFooterLabel("fix/beautify-style-review", 16), "fix/beautify-sty…");
	assert.equal(clipFooterLabel("x".repeat(16), 16), "x".repeat(16), "at the cap is unchanged");
	assert.equal(clipFooterLabel("fix/beautify-style-review", 0), "fix/beautify-style-review");
	assert.equal(clipFooterLabel("修复很长的分支名称中文测试", 4), "修复很长…", "按字符而不是字节");
});

test("footer clips the session name and the branch but keeps the git stats", () => {
	const previous = { ...config };
	let element!: { render: (width: number) => string[]; dispose: () => void };
	const ctx = {
		cwd: "/repo/project",
		hasUI: true,
		getContextUsage: () => undefined,
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionName: () => "a-very-long-session-name",
		},
		ui: {
			setFooter: (factory: (tui: unknown, theme: unknown, data: unknown) => typeof element) => {
				element = factory(
					{ requestRender: () => {} },
					{
						fg: (_color: string, text: string) => text,
						getThinkingBorderColor: () => (text: string) => text,
					},
					{
						getGitBranch: () => "feature/an-extremely-long-branch-name",
						getExtensionStatuses: () => new Map(),
						onBranchChange: () => () => {},
					},
				);
			},
		},
	};
	try {
		Object.assign(config, { footerNerdIcons: false, footerGitStatsMode: "off", footerLabelClip: 16 });
		applyCustomFooter(ctx as never);
		const line2 = element.render(200)[1]!;
		assert.match(line2, /project in a-very-long-sess…/);
		assert.match(line2, /feature\/an-extre…/);
		assert.ok(element.render(60)[1]!.length <= 60, "clipped line stays inside the width");
	} finally {
		Object.assign(config, previous);
	}
});

test("indentFooterLine never exceeds the renderer width", () => {
	// 缩进 2 列是默认值（editorPaddingX 0 + `❯ ` 2 列）。窄于缩进时必须先截缩进。
	for (const width of [0, 1, 2, 3, 4, 10, 80]) {
		const line = indentFooterLine("abcdef", width, 2);
		assert.ok(
			visibleWidth(line) <= width,
			`width=${width} produced ${visibleWidth(line)} columns: ${JSON.stringify(line)}`,
		);
	}
	assert.equal(indentFooterLine("abc", 10, 2), "  abc");
	assert.equal(indentFooterLine("abc", 1, 2), " ", "缩进被截到 width");
	assert.equal(indentFooterLine("abc", 0, 2), "", "零宽度不输出任何内容");
});
