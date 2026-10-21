import assert from "node:assert/strict";
import test from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
	Container,
	KeybindingsManager,
	Spacer,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { config, normalizeConfig, setConfig } from "../extensions/config/config.ts";
import {
	applyStartupHeader,
	clearStartupHeader,
	installEarlyStartupHeader,
	renderHeaderLines,
} from "../extensions/feature/shell/startup-header.ts";

// 模拟 pi 运行时：注册 app.* 键绑定（默认与 pi 内置一致）
setKeybindings(
	new KeybindingsManager({
		...TUI_KEYBINDINGS,
		"app.interrupt": { defaultKeys: "escape" },
		"app.clear": { defaultKeys: "ctrl+c" },
		"app.exit": { defaultKeys: "ctrl+d" },
		"app.tools.expand": { defaultKeys: "ctrl+o" },
	} as never),
);

// 无 ANSI 的 mock 主题：宽度即可见宽度，便于断言布局
const theme = {
	getFgAnsi: () => "",
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const visibleWidth = (line: string) => [...stripAnsi(line)].length;

const HERO_TEXT = "There are many agent harnesses, but this one is yours.";

test("双栏：logo 与 tips 并排，右栏从固定列开始", () => {
	const lines = renderHeaderLines(120, theme);
	assert.equal(lines.length, 5);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 120, "所有行不超宽");
	}
	assert.ok(lines[0]!.includes(`pi v${VERSION}`));
	assert.ok(lines[4]!.includes(HERO_TEXT));
	assert.ok(!lines.some((line) => line.includes("Pi can explain its own features")));
	assert.equal(stripAnsi(lines[0]!).indexOf("pi v"), 10);
	assert.equal(visibleWidth(lines[0]!.slice(0, 8)), 8);
});

test("窄屏回退：垂直堆叠 logo + hero 单行", () => {
	const lines = renderHeaderLines(40, theme);
	assert.equal(lines.length, 9); // 空+5 logo(官方 4 行+空行)+空+hero+空
	assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	assert.ok(!lines.some((line) => line.includes("Press ctrl+o")));
});

test("右栏按键文本来自 keybinding 动态渲染", () => {
	const lines = renderHeaderLines(120, theme);
	assert.ok(lines.some((line) => line.includes("escape interrupt")));
	assert.ok(lines.some((line) => line.includes("ctrl+o more")));
	assert.ok(lines.some((line) => line.includes("Press ctrl+o to show full startup help")));
});

test("禁用启动头时不清理其他扩展的 header", () => {
	const previous = { ...config };
	const calls: unknown[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			setHeader: (factory: unknown) => calls.push(factory),
		},
	};

	try {
		setConfig(normalizeConfig({ showStartupHeader: false }));
		applyStartupHeader(ctx);
		assert.deepEqual(calls, []);

		clearStartupHeader(ctx);
		assert.deepEqual(calls, [undefined]);
	} finally {
		setConfig(previous);
	}
});

/** 模拟 pi 的 init 顺序：建原生 header → 挂容器 → requestRender。 */
function fakeInit(): (this: any) => Promise<void> {
	return async function (this: any) {
		this.headerContainer.addChild(new Spacer(1));
		this.headerContainer.addChild(this.builtInHeader);
		this.headerContainer.addChild(new Spacer(1));
		this.ui.requestRender();
	};
}

function fakeMode(calls: string[]): any {
	return {
		headerContainer: new Container(),
		builtInHeader: { render: () => ["native header"] },
		ui: { requestRender: () => calls.push("requestRender") },
		setExtensionHeader(factory: unknown) {
			calls.push("setExtensionHeader");
			this.factory = factory;
		},
	};
}

/** 把 InteractiveMode.prototype.init 换成模拟实现，返回启动函数（走当前原型，含补丁包装）。 */
async function withFakeInit(
	run: (start: (mode: any) => Promise<void>) => Promise<void>,
): Promise<void> {
	const prototype = InteractiveMode.prototype as any;
	const realInit = prototype.init;
	prototype.init = fakeInit();
	try {
		await run((mode) => prototype.init.call(mode));
	} finally {
		prototype.init = realInit;
	}
}

test("原生 header 进容器的瞬间就换成 ccstyle 的，早于首次绘制", async () => {
	const previous = { ...config };
	const calls: string[] = [];
	try {
		setConfig(normalizeConfig({ showStartupHeader: true }));
		await withFakeInit(async (start) => {
			installEarlyStartupHeader();
			const mode = fakeMode(calls);
			await start(mode);
			// 两个 Spacer 不触发，只有 builtInHeader 触发；换头发生在 requestRender 之前
			assert.deepEqual(calls, ["setExtensionHeader", "requestRender"]);
			const component = (mode as any).factory(mode.ui, theme);
			assert.ok(
				component.render(120).some((line: string) => line.includes(`pi v${VERSION}`)),
				"工厂产出 ccstyle 启动头",
			);
		});
	} finally {
		setConfig(previous);
	}
});

test("关掉启动头时不抢原生 header", async () => {
	const previous = { ...config };
	const calls: string[] = [];
	try {
		setConfig(normalizeConfig({ showStartupHeader: false }));
		await withFakeInit(async (start) => {
			installEarlyStartupHeader();
			await start(fakeMode(calls));
			assert.deepEqual(calls, ["requestRender"]);
		});
	} finally {
		setConfig(previous);
	}
});

test("重复安装只包一层，重装后仍只换一次头", async () => {
	const previous = { ...config };
	const calls: string[] = [];
	try {
		setConfig(normalizeConfig({ showStartupHeader: true }));
		await withFakeInit(async (start) => {
			installEarlyStartupHeader();
			installEarlyStartupHeader();
			await start(fakeMode(calls));
			assert.deepEqual(calls, ["setExtensionHeader", "requestRender"]);
		});
	} finally {
		setConfig(previous);
	}
});
