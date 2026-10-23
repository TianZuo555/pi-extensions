import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TuiMainScreen } from "@earendil-works/pi-tui";
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
	const dispose = installMainScreenDoRenderPatch();
	try {
		assert.notEqual(prototype.applyLineResets, before, "补丁已安装");
		dispose();
		assert.equal(prototype.applyLineResets, before, "disposer 还原原始方法");
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
