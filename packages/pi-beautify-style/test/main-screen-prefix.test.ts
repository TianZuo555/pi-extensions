import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { installMainScreenDoRenderPatch } from "../extensions/utils/fullscreen-detect.ts";

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
	installMainScreenDoRenderPatch();
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
		tui.stop({ preserveScreen: true });
		rmSync(dir, { recursive: true, force: true });
	}
});
