import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import claudeCodeStyle, { getCompactThinkingConfig } from "../extensions/renderer/index.ts";
import { installCompactThinking } from "../extensions/feature/compact-thinking.ts";

initTheme("dark");

function runtime() {
	const handlers = new Map<string, Function[]>();
	return {
		pi: {
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
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

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();

function makeCtx(parent: Container, sessionManager: any) {
	const theme = { fg: (_c: string, t: string) => t };
	const tui: any = {
		mode: "regular",
		getMountedRoots: () => [parent],
		terminal: { columns: 120, rows: 40, write() {} },
		requestRender() {},
		render(width: number) {
			return this.children.flatMap((child: any) => child.render(width));
		},
	};
	return {
		tui,
		ctx: {
			mode: "tui",
			hasUI: true,
			sessionManager,
			ui: {
				theme,
				setStatus() {},
				notify() {},
				requestRender() {},
				setWidget(_key: string, factory: any) {
					if (typeof factory === "function") factory(tui);
				},
				onTerminalInput() {
					return () => {};
				},
			},
		} as any,
	};
}

// 真实 bash 工具定义的形状：自定义 renderCall/renderResult，无 renderShell。
// resume 时组件用原始原型构造 → 内容进 contentBox；补丁装上后 getRenderShell
// 返回 "self"，若 updateDisplay 未被重新触发，render() 读空的
// selfRenderContainer → 组件整体消失（回归：mounted 扫描强制 updateDisplay）。
test("tool built before patch stays visible after resume (mounted scan refreshes it)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tool-resume-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const parent = new Container() as any;
	const { ctx } = makeCtx(parent, { getBranch: () => [], getEntries: () => [] });
	const bashDefinition = {
		name: "bash",
		renderCall: () => ({ render: () => ["$ bash"], invalidate() {} }),
		renderResult: () => ({ render: () => ["out"], invalidate() {} }),
	} as any;

	const first = runtime();
	try {
		claudeCodeStyle(first.pi as any, { mode: "on" }, undefined as any);
		installCompactThinking(first.pi, getCompactThinkingConfig());
		first.emit("session_start", {}, ctx);
		first.emit("session_shutdown", { reason: "resume" }, ctx);

		// pi renderCurrentSessionState: original prototype, real tool definition
		const tool = new ToolExecutionComponent(
			"bash",
			"c1",
			{},
			{},
			bashDefinition,
			ctx.ui,
			process.cwd(),
		) as any;
		tool.updateResult({ content: [{ type: "text", text: "out" }], isError: false });
		parent.addChild(tool);
		assert.equal(tool.getRenderShell(), "default", "native shell before patch");

		// new extension instance: session_start installs patches; mounted scan must
		// re-trigger updateDisplay so content lands in the self-render container
		const second = runtime();
		claudeCodeStyle(second.pi as any, { mode: "on" }, undefined as any);
		installCompactThinking(second.pi, getCompactThinkingConfig());
		second.emit("session_start", { reason: "resume" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const lines = parent.render(120).map(stripAnsi).filter(Boolean);
		assert.ok(
			lines.some((l: string) => /bash|out|returned/i.test(l)),
			`tool must stay visible after resume, got: ${JSON.stringify(lines)}`,
		);

		second.emit("session_shutdown", {}, ctx);
	} finally {
		first.emit("session_shutdown", {}, ctx);
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});
