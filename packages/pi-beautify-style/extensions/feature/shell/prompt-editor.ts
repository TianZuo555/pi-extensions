/**
 * 输入框 `❯` 提示符（issue #68）。
 *
 * `PromptEditor` 继承 `CustomEditor`：pi 的 setCustomEditorComponent 会自动接线
 * onSubmit/onChange/actionHandlers/autocomplete/工作状态指示器，本扩展只管渲染。
 *
 * `❯ ` 恒占左侧 2 列：渲染前把 paddingX 抬到「用户值 + 2」（直接改字段绕过
 * setter，避免每帧 requestRender 自激），渲染后恢复。首内容行前两列换成
 * `❯ `，其后仍保留用户 editorPaddingX 的空格。
 * `❯` 颜色直接用 `borderColor`，随 thinking 等级 / bash mode 自动联动。
 *
 * `userPaddingX` 记录渲染时读到的用户 editorPaddingX（pi 通过 setPaddingX
 * 同步进本编辑器），footer 用 `inputTextIndent()` 对齐输入文本起始列：
 * 前缀开 = userPaddingX + 2，关 = userPaddingX。
 */
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { config } from "../../config/config.ts";

/** `❯ ` 固定 2 列：glyph + 尾随空格。 */
const PROMPT_GLYPH = "❯";
const PROMPT_COLS = 2;

/** 最近一次 render 读到的用户 editorPaddingX；未启用过提示符时为 0。 */
let userPaddingX = 0;

/** 输入文本起始列：footer 按它对齐。 */
export function inputTextIndent(): number {
	return config.enableEditorPrefix ? userPaddingX + PROMPT_COLS : userPaddingX;
}

export class PromptEditor extends CustomEditor {
	render(width: number): string[] {
		// ❯ + 用户 padding：文本从 userPaddingX+2 列开始。
		const self = this as unknown as { paddingX: number };
		const saved = self.paddingX;
		userPaddingX = saved;
		self.paddingX = saved + PROMPT_COLS;
		try {
			const lines = super.render(width);
			// 布局：lines[0] 顶边框，lines[1..n-2] 内容，lines[n-1] 底边框（autocomplete 在底边框后追加，
			// 首内容行恒为 index 1）。开头是 paddingX 个纯空格，前两列换成 ❯+空格，剩余 padding 保留；
			// 续行不动——Claude Code 行为。
			if (lines.length > 2 && lines[1].startsWith("  ")) {
				lines[1] = this.borderColor(PROMPT_GLYPH) + " " + lines[1].slice(2);
			}
			return lines;
		} finally {
			self.paddingX = saved;
		}
	}
}

type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];

const promptEditorFactory: EditorFactory = (tui, theme, keybindings) =>
	new PromptEditor(tui, theme, keybindings, { embedWorkingStatus: true });

/** 是否正占着插槽；占据前的工厂用于原样还回去。 */
let active = false;
let previousEditorFactory: EditorFactory | undefined;

/** 撤销本扩展占据的插槽；从未占用就不碰插槽。 */
function releasePromptEditor(ctx: ExtensionContext): void {
	if (!active) return;
	ctx.ui.setEditorComponent(previousEditorFactory);
	active = false;
	previousEditorFactory = undefined;
}

/** 应用输入框前缀；enableEditorPrefix=false 时只撤自己装的那层。 */
export function applyPromptEditor(ctx: ExtensionContext): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setEditorComponent !== "function") return;
	try {
		if (!config.enableEditorPrefix) {
			releasePromptEditor(ctx);
			return;
		}
		if (!active) {
			// pi 的插槽是硬替换、没有栈，先记住是谁占着，撤销时还回去。
			previousEditorFactory = ctx.ui.getEditorComponent?.();
			active = true;
		}
		ctx.ui.setEditorComponent(promptEditorFactory);
	} catch (err) {
		ctx.ui.notify(
			`prompt editor error: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

/** 恢复本扩展占据前的编辑器；未占用时不动作。 */
export function clearPromptEditor(ctx: ExtensionContext): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setEditorComponent !== "function") return;
	releasePromptEditor(ctx);
}
