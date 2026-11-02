import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, TuiMainScreen } from "@earendil-works/pi-tui";
import { MAIN_SCREEN_DO_RENDER_PATCH, patchRegistry } from "./patch-keys.ts";

/**
 * 官方 0.84+ 的 tui 引用是惰性 Proxy（createInteractiveTuiReference）：
 * 函数属性每次 get 都返回新包装，执行时才解析到当前实现。
 * 通过它捕获 doRender/render/handleInput 会解析到自身形成无限递归，
 * 因此检测到惰性 Proxy 时必须跳过所有"捕获后包装"类 patch。
 */
export function isLazyProxyTui(tui: any): boolean {
	if (!tui || typeof tui !== "object") return false;
	const probe = tui.requestRender;
	return typeof probe === "function" && probe !== tui.requestRender;
}

type MainScreenDoRenderPatch = {
	active: boolean;
	originalApplyLineResets: (lines: string[]) => string[];
	installedApplyLineResets: (lines: string[]) => string[];
	originalPositionHardwareCursor?: (cursorPos: any, totalLines: number) => void;
	installedPositionHardwareCursor?: (cursorPos: any, totalLines: number) => void;
};

/** 本帧补过的高度：插入位置与行数，交给 positionHardwareCursor 修正光标。 */
type DockPad = { missing: number; insertAt: number };

const DOCK_PAD_SLOT = Symbol("ccstyle-dock-pad");

/** 编辑器本帧渲染出的行（已归一化），`padDock` 靠它认出输入坞的起点。 */
let editorFrame: string[] = [];

/** 比对用的行：去掉 SGR、OSC、光标标记与行尾空白（applyLineResets 会补 reset）。 */
function normalizeFrameLine(line: string): string {
	return stripVTControlCharacters(line).split(CURSOR_MARKER).join("").trimEnd();
}

/**
 * 记下编辑器这一帧渲染出的行。
 *
 * `padDock` 只认这块内容，不按 `❯` 之类的字形反查：多行输入里粘贴的
 * `  ❯ npm test` 也像提示符，反查会把空行插进输入框中间，把输入框劈成两半。
 * `PromptEditor.render` 每帧先写这里，patch 再读同一帧的块。
 */
export function recordEditorFrame(lines: readonly string[]): void {
	editorFrame = lines.map(normalizeFrameLine);
}

/**
 * 输入坞（状态行、输入框、footer）的起始行：编辑器整块在帧里的最底一次出现。
 * 匹配整块而不是某一行，正文里重复的边框或提示符不会误伤；找不到（自定义
 * 编辑器没走 PromptEditor）就不补，保持 Pi 原生行为。
 */
function dockTopIndex(lines: string[]): number | undefined {
	const block = editorFrame;
	if (block.length === 0 || block.length > lines.length) return undefined;
	const plain = lines.map(normalizeFrameLine);
	for (let start = plain.length - block.length; start >= 0; start--) {
		let offset = 0;
		while (offset < block.length && plain[start + offset] === block[offset]) offset++;
		if (offset === block.length) return start;
	}
	return undefined;
}

function firstDifference(previous: string[], lines: string[]): number {
	const max = Math.max(previous.length, lines.length);
	for (let index = 0; index < max; index++) {
		if (previous[index] !== lines[index]) return index;
	}
	return -1;
}

/**
 * 内容收缩时在输入坞上方补空行，让输入框停在原屏幕行。
 *
 * regular 模式的整帧 = 正文 + 状态 + 输入框 + footer，终端只显示尾部。正文在
 * 视口内缩短（例如回合结束、思考块从 5 行收成 1 行）时，差分绘制把整个尾部往
 * 上挪，输入框跟着跳一行、底下留空。这里按收缩的行数在输入坞上方补等量空行：
 * 尾部行号不变，输入框不动，空行落在正文末尾，后续新内容会把它们吃掉。
 *
 * 视口上方的收缩走 fullRender 清屏重绘，坞本来就贴底，不补；找不到输入框也不补。
 */
function padDock(renderer: any, lines: string[]): string[] {
	// 上一帧的偏移不留给这一帧：补过才有值，用完即弃。
	delete renderer?.[DOCK_PAD_SLOT];
	const previous: unknown = renderer?.previousLines;
	const previousLines = Array.isArray(previous) ? (previous as string[]) : [];
	if (previousLines.length <= lines.length) return lines;
	const viewportTop = Math.max(0, Math.floor(Number(renderer?.previousViewportTop) || 0));
	const changed = firstDifference(previousLines, lines);
	// 视口上方变化（或整帧相同）不需要补：前者会整页重绘，后者没有位移。
	if (changed < 0 || changed < viewportTop) return lines;
	const insertAt = dockTopIndex(lines);
	if (insertAt === undefined) return lines;
	const missing = previousLines.length - lines.length;
	renderer[DOCK_PAD_SLOT] = { missing, insertAt } satisfies DockPad;
	const filler = new Array<string>(missing).fill("");
	return [...lines.slice(0, insertAt), ...filler, ...lines.slice(insertAt)];
}

/**
 * regular（TuiMainScreen）模式的 doRender 走差分绘制：一旦第一个变化行落在
 * previousViewportTop 之上（终端写不进 scrollback 的区域），只能
 * fullRender(true)——\x1b[2J\x1b[H\x1b[3J 清屏并清掉整段 scrollback。
 * compact 直播式回合的摘要行动画与流式正文渲染在回合工具卡/diff 面板上方；
 * diff 面板一落地把下方内容撑过屏高，之后每帧重绘都命中该分支：scrollback
 * 被反复清空，滚动条回弹、视口钉住，直到输出结束才恢复。
 *
 * 视口上方的行本就无法重写，只剩「清回滚重打」与「scrollback 保留旧文本」
 * 两条路。这里选后者：applyLineResets 是差分比较前最后一个拿到整帧的环节，
 * 把 previousLines 的视口上方前缀直接对齐新帧，差分只看到可写区域，照常增量
 * 绘制。代价仅是 scrollback 里那几行停留在最后一次实际写入的内容。
 *
 * 同一处还负责「输入坞钉底」（见 padDock），所以也包装 positionHardwareCursor：
 * 光标行号取自补空行之前的整帧，补过之后要加回同样的偏移。
 */
export function installMainScreenDoRenderPatch(): () => void {
	const noop = () => {};
	const prototype = TuiMainScreen.prototype as any;
	if (typeof prototype?.applyLineResets !== "function") return noop;
	const previous = patchRegistry.get<MainScreenDoRenderPatch>(MAIN_SCREEN_DO_RENDER_PATCH);
	if (previous) previous.active = false;
	const originalApply =
		previous && prototype.applyLineResets === previous.installedApplyLineResets
			? previous.originalApplyLineResets
			: prototype.applyLineResets;
	const hasCursorMethod = typeof prototype.positionHardwareCursor === "function";
	const originalCursor =
		hasCursorMethod &&
		previous &&
		prototype.positionHardwareCursor === previous.installedPositionHardwareCursor
			? previous.originalPositionHardwareCursor
			: prototype.positionHardwareCursor;
	const patch: MainScreenDoRenderPatch = {
		active: true,
		originalApplyLineResets: originalApply,
		installedApplyLineResets(this: any, lines: string[]) {
			if (!patch.active) return originalApply.call(this, lines);
			const padded = padDock(this, originalApply.call(this, lines));
			const prev = this.previousLines;
			if (!Array.isArray(prev)) return padded;
			const top = Math.min(
				Math.max(0, Math.floor(Number(this.previousViewportTop) || 0)),
				padded.length,
			);
			for (let i = 0; i < top; i++) prev[i] = padded[i];
			return padded;
		},
		originalPositionHardwareCursor: originalCursor,
		installedPositionHardwareCursor(this: any, cursorPos: any, totalLines: number) {
			const pad: DockPad | undefined = this?.[DOCK_PAD_SLOT];
			delete this?.[DOCK_PAD_SLOT];
			const adjusted =
				patch.active && pad && cursorPos && Number(cursorPos.row) >= pad.insertAt
					? { ...cursorPos, row: Number(cursorPos.row) + pad.missing }
					: cursorPos;
			return originalCursor?.call(this, adjusted, totalLines);
		},
	};
	prototype.applyLineResets = patch.installedApplyLineResets;
	if (hasCursorMethod) prototype.positionHardwareCursor = patch.installedPositionHardwareCursor;
	patchRegistry.install(MAIN_SCREEN_DO_RENDER_PATCH, patch);
	// 所有权守卫：/reload 后旧模块不能还原新模块的补丁，也不能在原型已被
	// 别人重新包装时把 ours 拆掉。
	return () => {
		patch.active = false;
		if (prototype.applyLineResets === patch.installedApplyLineResets) {
			prototype.applyLineResets = patch.originalApplyLineResets;
		}
		if (
			hasCursorMethod &&
			prototype.positionHardwareCursor === patch.installedPositionHardwareCursor
		) {
			prototype.positionHardwareCursor = patch.originalPositionHardwareCursor;
		}
		patchRegistry.dispose(MAIN_SCREEN_DO_RENDER_PATCH, patch);
	};
}
