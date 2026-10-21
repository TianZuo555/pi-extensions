import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import claudeCodeStyleExtension from "../extensions/renderer/index.ts";
import { ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";

initTheme("dark");

function runtime() {
	const events = new Map<string, Function>();
	return {
		events,
		pi: {
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		},
	};
}

test("stale TUI shutdown leaves the replacement runtime active", async () => {
	const containerPrototype = Container.prototype as any;
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const containerMethods = ["addChild", "removeChild", "clear"] as const;
	const toolMethods = [
		"hasRendererDefinition",
		"getRenderShell",
		"getCallRenderer",
		"getResultRenderer",
	] as const;
	const originalContainer = Object.fromEntries(
		containerMethods.map((name) => [name, containerPrototype[name]]),
	) as Record<string, Function>;
	const originalTool = Object.fromEntries(
		toolMethods.map((name) => [name, toolPrototype[name]]),
	) as Record<string, Function>;
	const runtimeA = runtime();
	const runtimeB = runtime();
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { theme, setStatus() {}, requestRender() {} },
	} as any;

	try {
		claudeCodeStyleExtension(runtimeA.pi as any, { mode: "on" });
		await runtimeA.events.get("session_start")?.({}, ctx);
		claudeCodeStyleExtension(runtimeB.pi as any, { mode: "on" });
		await runtimeB.events.get("session_start")?.({}, ctx);
		const replacementContainer = Object.fromEntries(
			containerMethods.map((name) => [name, containerPrototype[name]]),
		) as Record<string, Function>;
		const replacementTool = Object.fromEntries(
			toolMethods.map((name) => [name, toolPrototype[name]]),
		) as Record<string, Function>;
		const patchKey = Symbol.for("pi.ccstyle.global-tool-render-patch");
		const replacementPatch = (globalThis as any)[patchKey];

		await runtimeA.events.get("session_shutdown")?.({}, ctx);
		assert.equal((globalThis as any)[patchKey], replacementPatch);
		assert.equal(replacementPatch.active, true);
		for (const name of containerMethods)
			assert.equal(containerPrototype[name], replacementContainer[name]);
		for (const name of toolMethods) assert.equal(toolPrototype[name], replacementTool[name]);

		const parent = new Container() as any;
		for (const name of ["read", "bash"]) {
			const tool = new ToolExecutionComponent(
				name,
				`${name}-replacement-runtime`,
				{},
				{},
				undefined,
				ctx.ui,
				process.cwd(),
			) as any;
			tool.updateResult({ content: [], isError: false });
			parent.addChild(tool);
		}
		assert.ok(parent.children[0] instanceof ToolGroupComponent);

		await runtimeB.events.get("session_shutdown")?.({}, ctx);
		for (const name of containerMethods)
			assert.equal(containerPrototype[name], originalContainer[name]);
		for (const name of toolMethods) assert.equal(toolPrototype[name], originalTool[name]);
	} finally {
		await runtimeA.events.get("session_shutdown")?.({}, ctx);
		await runtimeB.events.get("session_shutdown")?.({}, ctx);
		for (const name of containerMethods) containerPrototype[name] = originalContainer[name];
		for (const name of toolMethods) toolPrototype[name] = originalTool[name];
		delete (globalThis as any)[Symbol.for("pi.ccstyle.global-tool-render-patch")];
	}
});

test("reload regroups the mounted transcript instead of leaving single tools", async () => {
	const first = runtime();
	const second = runtime();
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	};
	const parent = new Container() as any;
	const inputHandlers = new Set<Function>();
	let widget: any;
	const tui = {
		mode: "regular",
		children: [] as any[],
		getMountedRoots: () => [parent],
		terminal: { columns: 100, rows: 30, write() {} },
		previousLines: [] as string[],
		previousViewportTop: 0,
		requestRender() {},
		render(width: number) {
			return this.children.flatMap((child: any) => child.render(width));
		},
		doRender() {
			this.previousLines = this.render(100);
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme,
			setStatus() {},
			requestRender() {},
			setWidget(_key: string, factory: any) {
				widget = typeof factory === "function" ? factory(tui, theme) : undefined;
			},
			onTerminalInput(handler: Function) {
				inputHandlers.add(handler);
				return () => inputHandlers.delete(handler);
			},
		},
	} as any;
	try {
		claudeCodeStyleExtension(first.pi as any, { mode: "on" });
		await first.events.get("session_start")?.({}, ctx);
		for (const name of ["read", "bash"]) {
			const component = new ToolExecutionComponent(
				name,
				`reload-${name}`,
				{},
				{},
				undefined,
				ctx.ui,
				process.cwd(),
			) as any;
			component.updateResult({ content: [], isError: false });
			parent.addChild(component);
		}
		assert.ok(parent.children[0] instanceof ToolGroupComponent);

		await first.events.get("session_shutdown")?.({ reason: "reload" }, ctx);
		assert.equal(parent.children.length, 2, "old patch releases its group");

		claudeCodeStyleExtension(second.pi as any, { mode: "on" });
		await second.events.get("session_start")?.({ reason: "reload" }, ctx);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.ok(parent.children[0] instanceof ToolGroupComponent);
		assert.equal(parent.children[0].children.length, 2);
		assert.equal(inputHandlers.size, 1);
		assert.ok(widget);

		await first.events.get("session_shutdown")?.({ reason: "stale" }, ctx);
		assert.equal(inputHandlers.size, 1, "stale shutdown keeps replacement mouse listener");
		assert.ok(widget, "stale shutdown keeps replacement mouse widget");
	} finally {
		await first.events.get("session_shutdown")?.({}, ctx);
		await second.events.get("session_shutdown")?.({}, ctx);
	}
});

test("headless runtimes do not replace or shut down main TUI patches", async () => {
	const containerPrototype = Container.prototype as any;
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const originalContainerAdd = containerPrototype.addChild;
	const originalToolCallRenderer = toolPrototype.getCallRenderer;
	const mainStyle = runtime();
	const headlessStyle = runtime();
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	};
	const tuiCtx = {
		mode: "tui",
		hasUI: true,
		ui: { theme, setStatus() {}, requestRender() {} },
	} as any;
	const headlessCtx = {
		mode: "print",
		hasUI: false,
		ui: { theme, setStatus() {}, requestRender() {} },
	} as any;

	try {
		claudeCodeStyleExtension(mainStyle.pi as any, { mode: "on" });
		await mainStyle.events.get("session_start")?.({}, tuiCtx);

		const mainContainerAdd = containerPrototype.addChild;
		const mainToolCallRenderer = toolPrototype.getCallRenderer;
		assert.notEqual(mainContainerAdd, originalContainerAdd);
		assert.notEqual(mainToolCallRenderer, originalToolCallRenderer);

		claudeCodeStyleExtension(headlessStyle.pi as any, { mode: "on" });
		await headlessStyle.events.get("session_start")?.({}, headlessCtx);
		for (const name of [
			"session_compact",
			"message_start",
			"message_update",
			"message_end",
			"agent_start",
			"agent_end",
			"turn_start",
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		]) {
			await headlessStyle.events.get(name)?.({}, headlessCtx);
		}
		assert.equal(containerPrototype.addChild, mainContainerAdd);
		assert.equal(toolPrototype.getCallRenderer, mainToolCallRenderer);

		await headlessStyle.events.get("session_shutdown")?.({}, headlessCtx);
		assert.equal(containerPrototype.addChild, mainContainerAdd);
		assert.equal(toolPrototype.getCallRenderer, mainToolCallRenderer);

		const parent = new Container() as any;
		for (const name of ["read", "bash"]) {
			const tool = new ToolExecutionComponent(
				name,
				`${name}-isolation`,
				{},
				{},
				undefined,
				tuiCtx.ui,
				process.cwd(),
			) as any;
			tool.updateResult({ content: [], isError: false });
			parent.addChild(tool);
		}
		assert.ok(parent.children[0] instanceof ToolGroupComponent);
		assert.match(parent.children[0].render(100).join("\n"), /<success>●<\/success>/);
	} finally {
		await headlessStyle.events.get("session_shutdown")?.({}, headlessCtx);
		await mainStyle.events.get("session_shutdown")?.({}, tuiCtx);
		containerPrototype.addChild = originalContainerAdd;
		toolPrototype.getCallRenderer = originalToolCallRenderer;
	}
});
