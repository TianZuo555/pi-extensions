import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CURSOR_MARKER, TuiMainScreen } from "@earendil-works/pi-tui";
import { installMainScreenDoRenderPatch } from "../extensions/utils/fullscreen-detect.ts";
import { MAIN_SCREEN_DO_RENDER_PATCH, patchRegistry } from "../extensions/utils/patch-keys.ts";

function createTerminal(columns: number, rows: number) {
	const writes: string[] = [];
	return {
		columns,
		rows,
		writes,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		drainInput: async () => {},
		write(data: string) {
			writes.push(String(data));
		},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
	};
}

test("TuiMainScreen：视口上方的行变化不得 fullRender 清屏回顶", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-main-screen-"));
	const terminal = createTerminal(40, 5);
	const tui = new TuiMainScreen(terminal as any, false, dir);
	tui.setClearOnShrink(false);
	let body = Array.from({ length: 12 }, (_, index) => `line-${index}`);
	tui.addChild({
		render: () => body.slice(),
		invalidate() {},
	});
	const disposePatch = installMainScreenDoRenderPatch();
	try {
		tui.renderNow();
		const afterFirst = tui.fullRedraws;
		assert.ok(afterFirst >= 1, "首帧允许整页绘制");
		terminal.writes.length = 0;

		body = body.slice();
		body[0] = "CHANGED-TOP";
		tui.renderNow();
		const dumped = terminal.writes.join("");
		assert.equal(tui.fullRedraws, afterFirst, "视口上方改动不得再计一次 fullRender");
		assert.ok(!dumped.includes("\x1b[2J"), "不得清屏");
		assert.ok(!dumped.includes("\x1b[3J"), "不得清回滚");
	} finally {
		disposePatch();
		tui.stop({ preserveScreen: true });
		rmSync(dir, { recursive: true, force: true });
	}
});

test("installMainScreenDoRenderPatch 返回的 disposer 还原原型且可重复调用", () => {
	const prototype = TuiMainScreen.prototype as any;
	// 前面的用例可能留下了补丁：先取当前原型方法当基线，disposer 应还原到它。
	const before = prototype.applyLineResets;
	const beforeCursor = prototype.positionHardwareCursor;
	const dispose = installMainScreenDoRenderPatch();
	try {
		assert.notEqual(prototype.applyLineResets, before, "补丁已安装");
		assert.notEqual(prototype.positionHardwareCursor, beforeCursor, "光标定位也补了");
		dispose();
		assert.equal(prototype.applyLineResets, before, "disposer 还原原始方法");
		assert.equal(prototype.positionHardwareCursor, beforeCursor, "disposer 还原光标定位");
		dispose();
		assert.equal(prototype.applyLineResets, before, "重复调用无副作用");
	} finally {
		dispose();
	}
});

test("disposer 不拆掉别人后装的包装", () => {
	const prototype = TuiMainScreen.prototype as any;
	const before = prototype.applyLineResets;
	const dispose = installMainScreenDoRenderPatch();
	const ours = prototype.applyLineResets;
	// 模拟另一个扩展在我们之上再包一层。
	const external = function (this: any, lines: string[]) {
		return ours.call(this, lines);
	};
	prototype.applyLineResets = external;
	try {
		dispose();
		assert.equal(prototype.applyLineResets, external, "所有权守卫：不动别人的包装");
		assert.equal(patchRegistry.get(MAIN_SCREEN_DO_RENDER_PATCH), undefined);
		const lines = ["new"];
		const screen = { previousLines: ["old"], previousViewportTop: 1 };
		external.call(screen, lines);
		assert.deepEqual(screen.previousLines, ["old"], "disposed wrapper is inactive");
	} finally {
		prototype.applyLineResets = before;
	}
});

/** 去掉 SGR 才能比对正文（applyLineResets 会给每行补 reset）。 */
function plainLines(lines: string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line));
}

test("对照组：不装补丁时，正文收缩会把输入框顶上去", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-main-screen-"));
	const terminal = createTerminal(40, 20);
	const tui = new TuiMainScreen(terminal as any, false, dir);
	tui.setClearOnShrink(false);
	const border = "─".repeat(40);
	const dock = [border, "❯", border, "footer"];
	let transcript = Array.from({ length: 6 }, (_, index) => `line-${index}`);
	tui.addChild({
		render: () => [...transcript, ...dock],
		invalidate() {},
	});
	try {
		tui.renderNow();
		const before = plainLines((tui as any).previousLines).indexOf("❯");
		transcript = transcript.slice(0, 2);
		tui.renderNow();
		const after = plainLines((tui as any).previousLines).indexOf("❯");
		assert.equal(after, before - 4, "没有补丁时输入框随正文上移 4 行");
	} finally {
		tui.stop({ preserveScreen: true });
		rmSync(dir, { recursive: true, force: true });
	}
});

test("正文在视口内收缩时，输入框停在原来的屏幕行", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-main-screen-"));
	const terminal = createTerminal(40, 20);
	const tui = new TuiMainScreen(terminal as any, false, dir);
	tui.setClearOnShrink(false);
	const border = "─".repeat(40);
	const dock = [border, `❯${CURSOR_MARKER}`, border, "footer"];
	let transcript = Array.from({ length: 6 }, (_, index) => `line-${index}`);
	tui.addChild({
		render: () => [...transcript, ...dock],
		invalidate() {},
	});
	const disposePatch = installMainScreenDoRenderPatch();
	try {
		tui.renderNow();
		const promptRow = plainLines((tui as any).previousLines).indexOf("❯");
		const totalBefore = (tui as any).previousLines.length;
		assert.ok(promptRow > 0, "输入框在帧里");
		assert.equal((tui as any).hardwareCursorRow, promptRow, "首帧光标落在输入框行");

		// 回合结束：思考块从 5 行收成 1 行，视口内少 4 行。
		transcript = transcript.slice(0, 2);
		tui.renderNow();
		const after = plainLines((tui as any).previousLines);
		assert.equal(after.indexOf("❯"), promptRow, "输入框不跟着上移");
		assert.equal((tui as any).previousLines.length, totalBefore, "整帧高度不变");
		assert.equal(
			after.filter((line) => line === "").length,
			4,
			"收缩出来的 4 行补成空行",
		);
		assert.equal((tui as any).hardwareCursorRow, promptRow, "光标跟在输入框上");

		// 新输出先吃空行：坞不动，帧高不变。
		transcript = [...transcript, "next-0", "next-1"];
		tui.renderNow();
		const grown = plainLines((tui as any).previousLines);
		assert.equal(grown.indexOf("❯"), promptRow, "新输出不推走输入框");
		assert.equal((tui as any).previousLines.length, totalBefore, "空行被吃掉");
		assert.equal(
			grown.filter((line) => line === "").length,
			2,
			"补过的 4 行用掉 2 行",
		);
	} finally {
		disposePatch();
		tui.stop({ preserveScreen: true });
		rmSync(dir, { recursive: true, force: true });
	}
});

test("没有输入框提示符时保持原生行为：帧直接收缩", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-main-screen-"));
	const terminal = createTerminal(40, 20);
	const tui = new TuiMainScreen(terminal as any, false, dir);
	tui.setClearOnShrink(false);
	let transcript = Array.from({ length: 6 }, (_, index) => `line-${index}`);
	tui.addChild({
		render: () => [...transcript, "footer"],
		invalidate() {},
	});
	const disposePatch = installMainScreenDoRenderPatch();
	try {
		tui.renderNow();
		const totalBefore = (tui as any).previousLines.length;
		transcript = transcript.slice(0, 2);
		tui.renderNow();
		assert.equal((tui as any).previousLines.length, totalBefore - 4, "不补空行");
	} finally {
		disposePatch();
		tui.stop({ preserveScreen: true });
		rmSync(dir, { recursive: true, force: true });
	}
});
