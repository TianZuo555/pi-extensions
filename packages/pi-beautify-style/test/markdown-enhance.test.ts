import { test } from "node:test";
import assert from "node:assert";
import { default as enhance } from "../extensions/renderer/markdown-enhance.ts";

const transformers: Array<(md: string, ctx?: object) => string> = [];
enhance({
	registerMarkdownTransformer: (fn: (md: string, ctx?: object) => string) => transformers.push(fn),
} as never);
const run = (
	md: string,
	ctx = { messageType: "assistant", isStreaming: false, availableWidth: 100 },
) => transformers.reduce((acc, fn) => fn(acc, ctx), md);

test("mermaid 方言渲染", () => {
	assert.ok(run("```sequenceDiagram\nA->>B: hi\n```").includes("┌"));
	assert.ok(run("```stateDiagram-v2\n[*] --> S\n```").includes("╭"));
	assert.ok(run("```classDiagram\nclass A\n```").includes("┌"));
	assert.ok(run("```mermaid\ngraph LR\nA --> B\n```").includes("┌"));
});

test("四反引号围栏", () => {
	assert.ok(run("````mermaid\ngraph LR\nA --> B\n````").includes("┌"));
});

test("未闭合 fence 保留原文", () => {
	const out = run("```mermaid\ngraph LR\nA --> B");
	assert.ok(out.includes("```mermaid") && out.includes("A --> B"));
});

test("图行硬换行", () => {
	const out = run("```mermaid\ngraph LR\nA --> B\n```");
	const lines = out.split("\n").filter((l) => l.startsWith("`┌") || l.includes("┌────"));
	assert.ok(lines.length >= 1, JSON.stringify(out.slice(0, 80)));
});

test("宽度不足框装", () => {
	const out = run("```erdiagram\nCUSTOMER ||--o{ ORDER : places\n```", {
		messageType: "assistant",
		isStreaming: false,
		availableWidth: 10,
	});
	assert.ok(out.includes("╭"));
});

test("流式跳过", () => {
	const md = "```mermaid\ngraph LR\nA --> B\n```";
	assert.strictEqual(
		run(md, { messageType: "assistant", isStreaming: true, availableWidth: 100 }),
		md,
	);
});

test("thinking 块不转换（与官方推荐一致）", () => {
	const md = "```mermaid\ngraph LR\nA --> B\n```\n\n圈数字 ①\n\n看 https://example.com";
	assert.strictEqual(
		run(md, { messageType: "assistant-thinking", isStreaming: false, availableWidth: 100 }),
		md,
	);
});

test("裸 URL 与提示框不接管，交给 pi 原生渲染", () => {
	assert.strictEqual(
		run("访问 https://example.com/docs. 结束"),
		"访问 https://example.com/docs. 结束",
	);
	assert.strictEqual(run("> [!NOTE] 提示\n> 续行"), "> [!NOTE] 提示\n> 续行");
});

test("流式跨行链接不产生空白 OSC 8 点击区", () => {
	const md = "前缀 [\n](https://example.com)\n```md\n[代码\n链接](https://code.example)\n```";
	const out = run(md, {
		messageType: "assistant",
		isStreaming: true,
		availableWidth: 100,
	});
	assert.ok(out.includes("前缀 [](https://example.com)"), JSON.stringify(out));
	assert.ok(out.includes("[代码\n链接](https://code.example)"), JSON.stringify(out));
});

test("圈数字转半角括号（Nerd Font 字形缺陷规避）", () => {
	assert.strictEqual(run("方案②引入，共⑩项"), "方案(2)引入，共(10)项");
	assert.ok(run("① ② ⑳").includes("(1) (2) (20)"));
});

test("引用块和长围栏里的代码不被改写", () => {
	const quoted = run("> ```ts\n> const n = ①\n> ```\nplain ①");
	assert.match(quoted, /> const n = ①/);
	assert.match(quoted, /plain \(1\)/);

	const longer = run("````\n```\nstill code ①\n````\nafter ①");
	assert.match(longer, /still code ①/);
	assert.match(longer, /after \(1\)/);

	const tilde = run("~~~\ncode ①\n~~~\nafter ①");
	assert.match(tilde, /code ①/);
	assert.match(tilde, /after \(1\)/);

	const indented = run("   ```\n  code ①\n   ```\nafter ①");
	assert.match(indented, /code ①/);
	assert.match(indented, /after \(1\)/);
});
