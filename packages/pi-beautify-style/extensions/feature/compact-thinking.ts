// compact-thinking 本地内联实现。fork 自 pi-compact-thinking（MIT，
// https://github.com/tifandotme/pi-extensions/tree/master/packages/pi-compact-thinking）。
// 差异：
// 1. 不再依赖上游包 —— 配置解耦，由 claude-code-style 经 installCompactThinking
//    /updateConfig 管控（模块级 config 对象，不再读写 compact-thinking.json）。
// 2. 合并了上游 fork patch：subagent 工具（Agent/Agents）执行期间保持思考动画，
//    直到 tool_execution_end 或下一个 text/thinking 边界才收尾。
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Box, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { TOOL_CARD_BG_SLOT } from "../renderer/tool/tool-state.ts";
import { isToolTuiFullscreen } from "../renderer/tool/names.ts";
import {
	animateCompactThinkingText,
	formatThoughtDuration,
	styleCompactThinkingBody,
	styleCompactThinkingText,
} from "../renderer/compact-mode.ts";
import { refreshMountedTranscript } from "../renderer/transcript-refresh.ts";
import {
	COMPACT_THINKING_OWNER,
	COMPACT_THINKING_PATCH_KEY,
	patchRegistry,
	PROTOTYPE_ORIGINAL_KEY,
} from "../utils/patch-keys.ts";
// pi-tui 类型声明中 TUI 的 re-export 解析失败，本地用最小结构化类型（只用到 requestRender）。
type RenderTui = {
	requestRender(force?: boolean): void;
	focusedComponent?: unknown;
};

// pi-coding-agent 的类型声明中 AssistantMessageComponent 仅能以 value 形式使用。
type AssistantMessageComponentLike = InstanceType<typeof AssistantMessageComponent>;

export type CompactThinkingConfig = {
	useSummaryTitlesAsThinkingTitle: boolean;
	/**
	 * Max reasoning rows shown **while** a run streams. Longer text scrolls inside
	 * the window; the newest row stays at the bottom. A finished run hides the body
	 * entirely (heading only) until `app.thinking.toggle` (ctrl+t) expands it.
	 */
	liveThinkingLines: number;
	animationIntervalMs: number;
};

export type CompactThinkingController = {
	updateConfig(next: CompactThinkingConfig): void;
	/**
	 * 只读查询：某条 assistant message 的可见思考总时长（ms）。
	 * 供 compact 渲染层生成 `Thought for 8s` 摘要，不建立第二套计时器。
	 * 无记录且无进行中思考时返回 undefined。
	 */
	getMessageThinkingDurationMs?(messageTimestamp: number): number | undefined;
	/** 当前消息是否仍处于 compact-thinking 的活动思考态。 */
	isMessageThinkingActive?(messageTimestamp: number): boolean;
	/** 复用 compact-thinking 配置的动画帧，不建立独立动画计时器。 */
	getThinkingAnimationFrame?(): number;
	/** compact 摘要保持 loading 时复用 compact-thinking 的动画循环。 */
	setCompactSummaryActive?(active: boolean): void;
};

type DurationEntryData = {
	messageTimestamp: number;
	contentIndex: number;
	durationMs: number;
};

type SummaryPart = {
	title: string;
	body: string;
};

type ActiveThinking = {
	messageTimestamp: number;
	contentIndex: number;
	startedAt: number;
};

// pi-coding-agent 类型声明中 MarkdownTransformer 的 re-export 解析失败，本地用最小结构化类型。
type MarkdownTransformer = (
	markdown: string,
	context: {
		messageType: "user" | "assistant" | "assistant-thinking";
		isStreaming: boolean;
		availableWidth: number;
	},
) => string;

type AssistantInternals = {
	contentContainer: {
		clear(): void;
		addChild(component: Component): void;
	};
	hideThinkingBlock: boolean;
	markdownTheme: ConstructorParameters<typeof Markdown>[3];
	hiddenThinkingLabel: string;
	outputPad: number;
	isStreaming: boolean;
	markdownTransformers: readonly MarkdownTransformer[];
	lastMessage?: AssistantMessage;
	hasToolCalls: boolean;
	updateContent(message: AssistantMessage): void;
};

type PatchedPrototype = typeof AssistantMessageComponent.prototype & {
	updateContent: (message: AssistantMessage, isStreaming?: boolean) => void;
};

// 配置由 claude-code-style 管控（installCompactThinking 注入初始值，
// updateConfig 运行时更新），上游的配置文件读写已移除。
const config: CompactThinkingConfig = {
	useSummaryTitlesAsThinkingTitle: true,
	liveThinkingLines: 5,
	animationIntervalMs: 90,
};

const DURATION_ENTRY_TYPE = "compact-thinking-duration";

/** 当前激活 session 的只读查询委托（compact 渲染层使用）。 */
type ThinkingDurationQuery = (messageTimestamp: number) => number | undefined;
type ThinkingActiveQuery = (messageTimestamp: number) => boolean;
let activeThinkingQuery: ThinkingDurationQuery | undefined;
let activeThinkingStateQuery: ThinkingActiveQuery | undefined;
let activeThinkingAnimationFrameQuery: (() => number) | undefined;
let activeCompactSummarySetter: ((active: boolean) => void) | undefined;

function restoreDurationEntries(
	entries: Array<{ type: string; customType?: string; data?: unknown }>,
	completedDurations: Map<number, Map<number, number>>,
) {
	completedDurations.clear();
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== DURATION_ENTRY_TYPE ||
			!entry.data ||
			typeof entry.data !== "object"
		) {
			continue;
		}

		const data = entry.data as Partial<DurationEntryData>;
		if (
			typeof data.messageTimestamp !== "number" ||
			!Number.isFinite(data.messageTimestamp) ||
			typeof data.contentIndex !== "number" ||
			!Number.isInteger(data.contentIndex) ||
			typeof data.durationMs !== "number" ||
			!Number.isFinite(data.durationMs) ||
			data.durationMs < 1
		) {
			continue;
		}

		let durations = completedDurations.get(data.messageTimestamp);
		if (!durations) {
			durations = new Map();
			completedDurations.set(data.messageTimestamp, durations);
		}
		durations.set(data.contentIndex, data.durationMs);
	}
}

const THINKING_TOGGLE_KEYBINDING = "app.thinking.toggle";
const THINKING_TOGGLE_FALLBACK_KEY = "ctrl+t";

/**
 * 思考展开键。pi-tui 的 TUI_KEYBINDINGS 不含 app.thinking.toggle（它来自
 * pi-coding-agent 的 APP_KEYBINDINGS），纯渲染/测试环境取不到时回退到 Pi 的默认值。
 */
function thinkingToggleKeys(): string[] {
	try {
		const keys = getKeybindings().getKeys(THINKING_TOGGLE_KEYBINDING as never);
		return keys.length > 0 ? keys : [THINKING_TOGGLE_FALLBACK_KEY];
	} catch {
		return [THINKING_TOGGLE_FALLBACK_KEY];
	}
}

/**
 * 焦点是否在输入框上。只有 Pi 的 CustomEditor（含本扩展的 PromptEditor 子类）带
 * `actionHandlers` Map；选择器、/tree、扩展弹框都没有，它们自己的 ctrl+t 要放行
 * （例如 /tree 的 “hide tool results”）。焦点未建立（渲染测试）时按输入框处理。
 */
function isComposerFocused(tui: unknown): boolean {
	const focused = (tui as RenderTui | undefined)?.focusedComponent as
		| { actionHandlers?: unknown }
		| null
		| undefined;
	if (!focused) return true;
	return focused.actionHandlers instanceof Map;
}

function getThinkingToggleHint() {
	const keys = thinkingToggleKeys();
	return keys.length > 0 ? `${keys.join("/")} to expand` : undefined;
}

function thinkingExpandAction(): string | undefined {
	return isToolTuiFullscreen() ? "click to show more" : getThinkingToggleHint();
}

// 只 wrap 尾部窗口；缓存未着色折行，着色放到取出时做，避免主题切换命中旧 ANSI。
type PreviewCacheEntry = { lines: string[] };
const previewCache = new Map<string, PreviewCacheEntry>();
export const THINKING_PREVIEW_CACHE_MAX = 2_048;
const PREVIEW_BUDGET_MIN_CHARS = 2_000;
const PREVIEW_BUDGET_SLACK_LINES = 2;

function getCachedPreview(key: string): PreviewCacheEntry | undefined {
	const entry = previewCache.get(key);
	if (!entry) return undefined;
	previewCache.delete(key);
	previewCache.set(key, entry);
	return entry;
}

function cachePreview(key: string, entry: PreviewCacheEntry): void {
	previewCache.delete(key);
	while (previewCache.size >= THINKING_PREVIEW_CACHE_MAX) {
		const oldest = previewCache.keys().next().value;
		if (oldest === undefined) break;
		previewCache.delete(oldest);
	}
	previewCache.set(key, entry);
}

export function clearThinkingPreviewCache(): void {
	previewCache.clear();
	expandedWrapCache.clear();
}

type ExpandedWrapEntry = { text: string; lines: string[] };
const expandedWrapCache = new Map<string, ExpandedWrapEntry>();
export const THINKING_EXPANDED_WRAP_CACHE_MAX = 64;

function expandedWrapKey(messageTimestamp: number, runStartIndex: number, width: number): string {
	return `${messageTimestamp}:${runStartIndex}:${width}`;
}

function wrapExpandedThinking(
	messageTimestamp: number,
	runStartIndex: number,
	text: string,
	width: number,
): string[] {
	const key = expandedWrapKey(messageTimestamp, runStartIndex, width);
	const hit = expandedWrapCache.get(key);
	if (hit && hit.text === text) {
		expandedWrapCache.delete(key);
		expandedWrapCache.set(key, hit);
		return hit.lines;
	}
	const lines = wrapTextWithAnsi(text.replace(/\t/g, "   "), Math.max(1, width));
	expandedWrapCache.delete(key);
	while (expandedWrapCache.size >= THINKING_EXPANDED_WRAP_CACHE_MAX) {
		const oldest = expandedWrapCache.keys().next().value;
		if (oldest === undefined) break;
		expandedWrapCache.delete(oldest);
	}
	expandedWrapCache.set(key, { text, lines });
	return lines;
}

function evictExpandedWraps(messageTimestamp: number, runStartIndex: number): void {
	for (const key of expandedWrapCache.keys()) {
		const [ts, run] = key.split(":");
		if (Number(ts) === messageTimestamp && Number(run) === runStartIndex) {
			expandedWrapCache.delete(key);
		}
	}
}

export function thinkingPreviewCacheSize(): number {
	return previewCache.size;
}

export function thinkingExpandedWrapCacheSize(): number {
	return expandedWrapCache.size;
}

function padPreviewLine(line: string, width: number, padding: number): string {
	const left = padding > 0 ? " ".repeat(padding) : "";
	const right = padding > 0 ? " ".repeat(padding) : "";
	const withMargins = left + line + right;
	return withMargins + " ".repeat(Math.max(0, width - visibleWidth(withMargins)));
}

/** Tail window: wrap the newest `maxLines` rows and drop the rest above them. */
function layoutThinkingWindow(
	text: string,
	width: number,
	padding: number,
	maxLines: number,
): string[] {
	if (!text || maxLines <= 0) return [];
	const contentWidth = Math.max(1, width - padding * 2);
	const budget = Math.max(
		width * (maxLines + PREVIEW_BUDGET_SLACK_LINES),
		PREVIEW_BUDGET_MIN_CHARS,
	);
	let source = text;
	let cut = 0;
	if (source.length > budget) {
		const start = source.length - budget;
		const newline = source.indexOf("\n", start);
		cut = newline === -1 ? start : newline + 1;
		if (cut < source.length) source = source.slice(cut);
		else cut = 0;
	}
	const cacheKey = `${width}:${padding}:${cut}:${source}`;
	let entry = getCachedPreview(cacheKey);
	if (!entry) {
		entry = { lines: wrapTextWithAnsi(source.replace(/\t/g, "   "), contentWidth) };
		cachePreview(cacheKey, entry);
	}
	return entry.lines.length > maxLines ? entry.lines.slice(-maxLines) : entry.lines;
}

/**
 * 收尾卡的展开提示。运行中正文自己就是入口，不需要提示；收尾后正文全部隐藏，
 * 只用一行说明怎么打开。
 */
function collapsedThinkingHint(): { prefix: string; action: string; suffix: string } | undefined {
	const action = thinkingExpandAction();
	if (!action) return undefined;
	return { prefix: " · ", action, suffix: "" };
}

const expandedThinking = new Set<string>();
/** 全局展开时被单独收起的 run（点击收起）。与 Pi 的 thinkingVisibilityOverrides 同语义。 */
const collapsedThinking = new Set<string>();

/**
 * 全局展开态：`app.thinking.toggle`（默认 ctrl+t）一次性展开所有收尾思考卡的全文，
 * 之后新建的卡也跟着展开——与 Pi 自己那个持久开关同语义。
 * 全局展开期间点单张卡收起，只收起那一张。
 */
let allThinkingExpanded = false;

/** 测试与渲染层共用的只读查询。 */
export function isAllThinkingExpanded(): boolean {
	return allThinkingExpanded;
}

/** 设置全局展开态；`app.thinking.toggle` 与测试都走这里。 */
export function setAllThinkingExpanded(expanded: boolean): void {
	allThinkingExpanded = expanded;
	collapsedThinking.clear();
	expandedThinking.clear();
}

/** 折叠预览 + 展开全文。fullscreen 点击 hint 展开、展开卡单击整块收起（拖动选择文本时不收起）。 */
export class ThinkingPreviewBlock implements Component {
	private heading: string;
	private text: string;
	private padding: number;
	readonly messageTimestamp: number;
	readonly runStartIndex: number;
	private style: (text: string) => string;
	private theme: Theme | undefined;
	private hintHovered = false;
	private streaming = false;
	/** 运行中只记最后一帧的尾窗；收尾后正文全部隐藏，不再需要。 */
	private liveMemo:
		| { width: number; padding: number; text: string; maxLines: number; lines: string[] }
		| undefined;
	private collapsedMemo:
		| {
				width: number;
				liveThinkingLines: number;
				expanded: boolean;
				hintHovered: boolean;
				expandAction: string | undefined;
				streaming: boolean;
				lines: string[];
		  }
		| undefined;

	constructor(
		heading: string,
		text: string,
		padding: number,
		messageTimestamp: number,
		style: (text: string) => string,
		theme?: Theme,
		runStartIndex = 0,
		streaming = false,
	) {
		this.heading = heading;
		this.text = text;
		this.padding = padding;
		this.messageTimestamp = messageTimestamp;
		this.runStartIndex = runStartIndex;
		this.style = style;
		this.theme = theme;
		this.streaming = streaming;
	}

	private paint(color: string, text: string): string {
		return this.theme && typeof this.theme.fg === "function"
			? this.theme.fg(color as never, text)
			: text;
	}

	/** 展开态按消息时间戳 + run 序号共享：面板重排/内容重建换掉实例后，
	 *  布局里的旧实例与 render 的新实例同键，点谁都能展开。
	 *  全局展开优先，单卡收起可覆盖它。 */
	get expanded(): boolean {
		const key = `${this.messageTimestamp}:${this.runStartIndex}`;
		if (collapsedThinking.has(key)) return false;
		return allThinkingExpanded || expandedThinking.has(key);
	}

	setExpanded(expanded: boolean): void {
		const key = `${this.messageTimestamp}:${this.runStartIndex}`;
		if (expanded) {
			collapsedThinking.delete(key);
			expandedThinking.add(key);
		} else {
			expandedThinking.delete(key);
			if (allThinkingExpanded) collapsedThinking.add(key);
			evictExpandedWraps(this.messageTimestamp, this.runStartIndex);
		}
		this.collapsedMemo = undefined;
	}

	setHintHovered(hovered: boolean): void {
		if (this.hintHovered !== hovered) this.collapsedMemo = undefined;
		this.hintHovered = hovered;
	}

	private headingLines(width: number, padding: number): string[] {
		// 收起态（收尾且未展开）只留标题 + 打开提示；运行中正文自己就是入口。
		const hint = this.expanded || this.streaming ? undefined : collapsedThinkingHint();
		if (!hint) return new Text(this.heading, padding, 0).render(width);
		const rawHint = hint.prefix + hint.action + hint.suffix;
		const contentWidth = Math.max(1, width - padding * 2);
		const headingBudget = Math.max(0, contentWidth - visibleWidth(rawHint));
		const clipped =
			visibleWidth(this.heading) > headingBudget
				? truncateToWidth(this.heading, headingBudget, "")
				: this.heading;
		const action = this.paint(this.hintHovered ? "text" : "dim", hint.action);
		return new Text(
			clipped + this.paint("dim", hint.prefix) + action + this.paint("dim", hint.suffix),
			padding,
			0,
		).render(width);
	}

	/**
	 * 运行中：只显示最新 `liveThinkingLines` 行，多出的行向上滚出窗口；不包卡片，
	 * 也不受全局展开影响——正文一直在长，宽度/高度稳定才不闪。
	 * 收尾后：正文全部隐藏，只剩标题与打开提示；ctrl+t / 点击展开看全文。
	 */
	private bodyLines(width: number, padding: number): string[] {
		if (this.streaming) {
			if (!this.text) return [];
			const maxLines = config.liveThinkingLines;
			const memo = this.liveMemo;
			if (
				memo &&
				memo.width === width &&
				memo.padding === padding &&
				memo.text === this.text &&
				memo.maxLines === maxLines
			) {
				return memo.lines;
			}
			const window = layoutThinkingWindow(this.text, width, padding, maxLines);
			this.liveMemo = { width, padding, text: this.text, maxLines, lines: window };
			return window;
		}
		if (!this.text || !this.expanded) return [];
		return wrapExpandedThinking(this.messageTimestamp, this.runStartIndex, this.text, width);
	}

	render(width: number) {
		// 展开卡只在收尾后出现：运行中的正文是不包卡片的滚动尾窗。
		if (this.expanded && !this.streaming) {
			const innerWidth = Math.max(1, width - 2);
			const body = this.bodyLines(innerWidth, 0);
			const heading = this.headingLines(innerWidth, 0);
			const inner = body.length
				? [...heading, ...body.map((line) => this.style(line))]
				: heading;
			const bgFn =
				this.theme && typeof this.theme.bg === "function"
					? (text: string) => this.theme!.bg(TOOL_CARD_BG_SLOT.success, text)
					: undefined;
			const box = new Box(1, 1, bgFn);
			box.addChild({
				render: () => inner,
				invalidate() {},
			});
			return box.render(width);
		}

		const expandAction = thinkingExpandAction();
		if (
			this.collapsedMemo?.width === width &&
			this.collapsedMemo.liveThinkingLines === config.liveThinkingLines &&
			this.collapsedMemo.expanded === this.expanded &&
			this.collapsedMemo.hintHovered === this.hintHovered &&
			this.collapsedMemo.expandAction === expandAction &&
			this.collapsedMemo.streaming === this.streaming
		) {
			return this.collapsedMemo.lines;
		}

		const body = this.bodyLines(width, this.padding);
		const heading = this.headingLines(width, this.padding);
		const lines = body.length
			? [...heading, ...body.map((line) => padPreviewLine(this.style(line), width, this.padding))]
			: heading;
		this.collapsedMemo = {
			width,
			liveThinkingLines: config.liveThinkingLines,
			expanded: this.expanded,
			hintHovered: this.hintHovered,
			expandAction,
			streaming: this.streaming,
			lines,
		};
		return lines;
	}

	invalidate() {
		this.collapsedMemo = undefined;
		this.liveMemo = undefined;
	}
}

function parseSummaryPart(text: string): SummaryPart | undefined {
	const match = /^\s*\*\*([^\n]+?)\*\*[ \t]*(?:\r?\n(?:\r?\n)?([\s\S]*))?\s*$/.exec(text);
	if (!match) return undefined;
	return { title: match[1].trim(), body: (match[2] ?? "").trim() };
}

function parseLatestStreamingSummary(text: string): SummaryPart | undefined {
	// Providers do not consistently insert a blank line between streamed
	// summary parts, so accept a bold title at the start of any source line.
	const titlePattern = /(?:^|\r?\n)\s*\*\*([^\n*]+?)\*\*[ \t]*(?:\r?\n)?/g;
	let latest: RegExpExecArray | undefined;
	let match: RegExpExecArray | null;
	while ((match = titlePattern.exec(text))) latest = match;
	if (!latest) return parseSummaryPart(text);

	return {
		title: latest[1].trim(),
		body: text.slice(latest.index + latest[0].length).trim(),
	};
}

function isOpenAiResponsesMessage(message: AssistantMessage) {
	return (
		message.api === "openai-responses" ||
		message.api === "openai-codex-responses" ||
		message.api === "azure-openai-responses"
	);
}

function getLatestOpenAiSummary(thinkingSignature: string | undefined): SummaryPart | undefined {
	if (!thinkingSignature) return undefined;

	try {
		const item = JSON.parse(thinkingSignature) as {
			type?: unknown;
			summary?: Array<{ type?: unknown; text?: unknown }>;
		};
		if (item.type !== "reasoning" || !Array.isArray(item.summary)) {
			return undefined;
		}

		for (let i = item.summary.length - 1; i >= 0; i--) {
			const part = item.summary[i];
			if (part.type !== "summary_text" || typeof part.text !== "string") {
				continue;
			}
			const parsed = parseSummaryPart(part.text);
			if (parsed) return parsed;
		}
	} catch {
		// Invalid or provider-specific signatures use the generic fallback.
	}
	return undefined;
}

const WIDGET_ID = "compact-thinking-render-loop";

// 上游 index.ts 内联（含 subagent fork patch）。
function createTransform(
	messageType: "assistant" | "assistant-thinking",
	self: AssistantInternals,
) {
	// 与 pi 内置 applyMarkdownTransformers 相同的链式语义：
	// 异常保留当前 markdown，继续下一个 transformer。
	return (markdown: string, availableWidth: number): string => {
		let out = markdown;
		for (const transformer of self.markdownTransformers ?? []) {
			try {
				const result = transformer(out, {
					messageType,
					isStreaming: self.isStreaming,
					availableWidth,
				});
				if (typeof result === "string") out = result;
			} catch {
				// 保持当前 markdown 继续
			}
		}
		return out;
	};
}

function compactThinking(pi: ExtensionAPI) {
	const prototype = AssistantMessageComponent.prototype as PatchedPrototype;
	const originalUpdateContent = prototype.updateContent;

	activeThinkingStateQuery = (messageTimestamp) =>
		activeThinking?.messageTimestamp === messageTimestamp;
	activeThinkingAnimationFrameQuery = () => animationFrame;
	activeThinkingQuery = (messageTimestamp) => {
		let total = 0;
		const durations = completedDurations.get(messageTimestamp);
		if (durations) {
			for (const duration of durations.values()) total += duration;
		}
		if (activeThinking?.messageTimestamp === messageTimestamp) {
			total += Math.max(1, Date.now() - activeThinking.startedAt);
		}
		return total > 0 ? total : undefined;
	};

	const completedDurations = new Map<number, Map<number, number>>();
	const streamingComponents = new Set<AssistantMessageComponentLike>();
	let activeThinking: ActiveThinking | undefined;
	let activeTheme: Theme | undefined;
	let activeTui: RenderTui | undefined;
	let latestComponent: AssistantMessageComponentLike | undefined;
	let latestComponentTimestamp: number | undefined;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	let animationFrame = 0;
	let compactSummaryActive = false;
	let patchInstalled = true;

	function thinkingStyle(text: string) {
		return styleCompactThinkingText(text, activeTheme);
	}

	/** 正文用 Pi 的 thinkingText slot，标题仍用 dim。 */
	function thinkingBodyStyle(text: string) {
		return styleCompactThinkingBody(text, activeTheme);
	}

	function summaryTitleStyle(text: string) {
		return styleCompactThinkingText(text, activeTheme, true);
	}

	function animatedText(text: string, baseStyle: (value: string) => string, animate: boolean) {
		if (!animate) return baseStyle(text);
		return animateCompactThinkingText(
			text,
			activeTheme,
			animationFrame,
			baseStyle === summaryTitleStyle,
		);
	}

	function getCompletedDuration(messageTimestamp: number, startIndex: number, endIndex: number) {
		const durations = completedDurations.get(messageTimestamp);
		if (!durations) return undefined;
		for (let index = endIndex; index >= startIndex; index--) {
			const duration = durations.get(index);
			if (duration !== undefined) return duration;
		}
		return undefined;
	}

	function isActiveRun(message: AssistantMessage, startIndex: number, endIndex: number) {
		return (
			activeThinking?.messageTimestamp === message.timestamp &&
			activeThinking.contentIndex >= startIndex &&
			activeThinking.contentIndex <= endIndex
		);
	}

	prototype.updateContent = function patchedUpdateContent(
		message: AssistantMessage,
		isStreaming?: boolean,
	) {
		const component = this as AssistantMessageComponentLike;
		const self = this as unknown as AssistantInternals;
		// isStreaming 丢失 → mermaid 流式误渲染来回闪。
		self.isStreaming = isStreaming ?? self.isStreaming;
		self.lastMessage = message;
		latestComponent = component;
		latestComponentTimestamp = message.timestamp;

		// This package always owns the reasoning card: the live body is a
		// `liveThinkingLines`-tall tail window, and a finished run hides the body
		// behind the heading until `app.thinking.toggle` expands it. Pi's own
		// renderer would keep the whole body mounted after the run ends.

		if (activeThinking?.messageTimestamp === message.timestamp) {
			streamingComponents.add(component);
		}

		self.contentContainer.clear();
		const hasActiveThinking =
			activeThinking?.messageTimestamp === message.timestamp &&
			message.content.some((content) => content.type === "thinking");
		const hasVisibleContent =
			hasActiveThinking ||
			message.content.some(
				(content) =>
					(content.type === "text" && content.text.trim()) ||
					(content.type === "thinking" && content.thinking.trim()),
			);
		// Reserve Pi's normal leading spacer even before the first thinking token.
		// This prevents the placeholder heading from jumping down one row when
		// summary/body content begins streaming.
		if (hasVisibleContent) self.contentContainer.addChild(new Spacer(1));

		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];

			if (content.type === "text" && content.text.trim()) {
				self.contentContainer.addChild(
					new Markdown(content.text.trim(), self.outputPad, 0, self.markdownTheme, undefined, {
						transform: createTransform("assistant", self),
					}),
				);
				continue;
			}

			if (content.type !== "thinking") continue;

			const runStartIndex = i;
			const hasVisibleContentBefore = message.content
				.slice(0, runStartIndex)
				.some(
					(previous) =>
						(previous.type === "text" && previous.text.trim()) ||
						(previous.type === "thinking" && previous.thinking.trim()),
				);
			const thinkingBlocks: string[] = [];
			let latestSummary: SummaryPart | undefined;
			for (; i < message.content.length; i++) {
				const thinkingContent = message.content[i];
				if (thinkingContent.type !== "thinking") break;
				const thinking = thinkingContent.thinking.trim();
				if (!thinking) continue;
				thinkingBlocks.push(thinking);

				if (config.useSummaryTitlesAsThinkingTitle && isOpenAiResponsesMessage(message)) {
					const contentIsActive =
						activeThinking?.messageTimestamp === message.timestamp &&
						activeThinking.contentIndex === i;
					// During streaming, thinkingSignature may contain only the previously
					// completed summary parts. Prefer the live text so a newly arriving
					// title immediately replaces the old one instead of appearing in its
					// preview body. Once complete, the structured signature is canonical.
					latestSummary = contentIsActive
						? (parseLatestStreamingSummary(thinking) ??
							getLatestOpenAiSummary(thinkingContent.thinkingSignature) ??
							latestSummary)
						: (getLatestOpenAiSummary(thinkingContent.thinkingSignature) ??
							parseLatestStreamingSummary(thinking) ??
							latestSummary);
				}
			}
			const runEndIndex = i - 1;
			i--;
			const active = isActiveRun(message, runStartIndex, runEndIndex);
			// OpenAI can spend several seconds reasoning before it emits the first
			// summary token. Keep an empty active block visible as animated
			// "Thinking..." during that otherwise silent interval.
			if (thinkingBlocks.length === 0 && !active) continue;
			if (hasVisibleContentBefore) {
				self.contentContainer.addChild(new Spacer(1));
			}

			const elapsedMs = activeThinking
				? Math.max(1, Date.now() - activeThinking.startedAt)
				: undefined;
			const completedMs = getCompletedDuration(message.timestamp, runStartIndex, runEndIndex);
			const durationMs = active ? elapsedMs : completedMs;
			const durationText = durationMs === undefined ? undefined : formatThoughtDuration(durationMs);

			let heading: string;
			if (active && latestSummary) {
				heading =
					animatedText(latestSummary.title, summaryTitleStyle, true) +
					(durationText ? thinkingStyle(` · ${durationText}`) : "");
			} else if (active) {
				const label = self.hiddenThinkingLabel || "Thinking...";
				heading =
					animatedText(label, thinkingStyle, true) +
					(durationText ? thinkingStyle(` · ${durationText}`) : "");
			} else {
				// Completed compact blocks use one provider-independent status line.
				// 无时长记录（中断流/旧会话/entry 缺失或索引错位）时不回退到加载文案
				// "Thinking..."：改用摘要标题或中性 "Thought"。
				heading = thinkingStyle(
					durationText ? `Thought for ${durationText}` : (latestSummary?.title ?? "Thought"),
				);
			}
			const previewSource = (latestSummary?.body ?? thinkingBlocks.join("\n\n")).trim();
			self.contentContainer.addChild(
				new ThinkingPreviewBlock(
					heading,
					previewSource,
					self.outputPad,
					message.timestamp,
					thinkingBodyStyle,
					activeTheme,
					runStartIndex,
					active,
				),
			);

			const hasVisibleContentAfter = message.content
				.slice(i + 1)
				.some(
					(next) =>
						(next.type === "text" && next.text.trim()) ||
						(next.type === "thinking" && next.thinking.trim()),
				);
			if (hasVisibleContentAfter) self.contentContainer.addChild(new Spacer(1));
		}

		const hasToolCalls = message.content.some((content) => content.type === "toolCall");
		self.hasToolCalls = hasToolCalls;

		if (message.stopReason === "length") {
			self.contentContainer.addChild(new Spacer(1));
			self.contentContainer.addChild(
				new Text(
					activeTheme
						? activeTheme.fg(
								"error",
								"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
							)
						: "Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
					self.outputPad,
					0,
				),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				self.contentContainer.addChild(new Spacer(1));
				self.contentContainer.addChild(
					new Text(
						activeTheme ? activeTheme.fg("error", abortMessage) : abortMessage,
						self.outputPad,
						0,
					),
				);
			} else if (message.stopReason === "error") {
				const errorMessage = message.errorMessage || "Unknown error";
				self.contentContainer.addChild(new Spacer(1));
				self.contentContainer.addChild(
					new Text(
						activeTheme
							? activeTheme.fg("error", `Error: ${errorMessage}`)
							: `Error: ${errorMessage}`,
						self.outputPad,
						0,
					),
				);
			}
		}
	};
	const installedUpdateContent = prototype.updateContent;
	(installedUpdateContent as any)[COMPACT_THINKING_PATCH_KEY] = true;

	function ensureAnimationTimer() {
		if (animationTimer) return;
		animationTimer = setInterval(() => {
			animationFrame++;
			for (const component of streamingComponents) {
				const self = component as unknown as AssistantInternals;
				if (self.lastMessage) self.updateContent(self.lastMessage);
			}
			activeTui?.requestRender();
		}, config.animationIntervalMs);
	}

	function stopAnimationTimerIfIdle() {
		if (activeThinking || compactSummaryActive || !animationTimer) return;
		clearInterval(animationTimer);
		animationTimer = undefined;
	}

	activeCompactSummarySetter = (active) => {
		compactSummaryActive = active;
		if (active) ensureAnimationTimer();
		else stopAnimationTimerIfIdle();
		activeTui?.requestRender();
	};

	function startThinking(message: AssistantMessage, contentIndex: number) {
		activeThinking = {
			messageTimestamp: message.timestamp,
			contentIndex,
			startedAt: Date.now(),
		};
		streamingComponents.clear();
		animationFrame = 0;

		// Depending on event-listener order, Pi may have rendered the empty
		// thinking_start partial just before this extension receives the event.
		// Re-render that component immediately so users do not wait for the first
		// summary delta before seeing the animation.
		if (latestComponent && latestComponentTimestamp === message.timestamp) {
			streamingComponents.add(latestComponent);
			const self = latestComponent as unknown as AssistantInternals;
			self.updateContent(message);
			activeTui?.requestRender();
		}

		if (animationTimer) clearInterval(animationTimer);
		animationTimer = undefined;
		ensureAnimationTimer();
	}

	function finishThinking() {
		if (!activeThinking) return;
		const finished = activeThinking;
		const durationMs = Math.max(1, Date.now() - finished.startedAt);
		let durations = completedDurations.get(finished.messageTimestamp);
		if (!durations) {
			durations = new Map();
			completedDurations.set(finished.messageTimestamp, durations);
		}
		durations.set(finished.contentIndex, durationMs);
		pi.appendEntry(DURATION_ENTRY_TYPE, {
			messageTimestamp: finished.messageTimestamp,
			contentIndex: finished.contentIndex,
			durationMs,
		} as DurationEntryData);

		activeThinking = undefined;
		stopAnimationTimerIfIdle();

		const components = [...streamingComponents];
		streamingComponents.clear();
		for (const component of components) {
			const self = component as unknown as AssistantInternals;
			if (self.lastMessage) self.updateContent(self.lastMessage);
		}
		activeTui?.requestRender();
	}

	// ---- fork patch：subagent 工具执行期间保持思考动画 ----

	// Subagent tools can run for minutes: keep the thinking loading animation
	// alive for the whole execution and only finalize once the tool ends or the
	// model emits the next text/thinking boundary.
	function resumeAgentThinking(message: AssistantMessage | undefined) {
		if (activeThinking) return;
		const content = message?.content;
		if (!Array.isArray(content)) return;
		const index = content.findIndex((item) => item?.type === "thinking");
		if (index < 0) return;
		startThinking(message as AssistantMessage, index);
	}

	function messageHasAgentTool(message: AssistantMessage | undefined) {
		return (
			Array.isArray(message?.content) &&
			message.content.some(
				(content) =>
					content?.type === "toolCall" &&
					(content.name === "Agent" ||
						content.name === "Agents" ||
						content.arguments?.subagent_type != null),
			)
		);
	}

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const update = event.assistantMessageEvent;

		if (update.type === "thinking_start") {
			if (activeThinking?.messageTimestamp === event.message.timestamp) {
				// Some Responses-compatible providers emit a fresh thinking_start for
				// each summary/reasoning item even though no text or tool boundary has
				// ended the visible Thinking run. Follow the new content block without
				// resetting the run's original start time.
				activeThinking.contentIndex = update.contentIndex;
			} else {
				if (activeThinking) finishThinking();
				startThinking(event.message, update.contentIndex);
			}
		} else if (update.type === "thinking_delta") {
			if (!activeThinking) {
				startThinking(event.message, update.contentIndex);
			} else if (activeThinking.messageTimestamp === event.message.timestamp) {
				activeThinking.contentIndex = update.contentIndex;
			}
		} else if (update.type === "text_start") {
			finishThinking();
		} else if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
			if (messageHasAgentTool(event.message)) {
				resumeAgentThinking(event.message);
			} else {
				finishThinking();
			}
		}
		// Do not finalize on thinking_end alone. OpenAI Responses providers can
		// close one reasoning item and immediately open another for the next
		// summary while Pi still renders both as one contiguous Thinking run.
		// A text/tool transition or message_end is the actual visible boundary.
	});

	// OpenAI-compatible providers may not close reasoning until the response ends.
	pi.on("tool_execution_start", (event: any) => {
		if (event.toolName === "Agent" || event.toolName === "Agents") {
			const lastMessage = (latestComponent as unknown as { lastMessage?: AssistantMessage })
				?.lastMessage;
			resumeAgentThinking(lastMessage);
		} else {
			finishThinking();
		}
	});
	pi.on("tool_execution_end", (event: any) => {
		if (event.toolName === "Agent" || event.toolName === "Agents") finishThinking();
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		// Agent tool runs after message_end; keep the ticker until tool_execution_end
		// or the next text/thinking boundary.
		if (messageHasAgentTool(event.message)) return;
		finishThinking();
	});

	// ---- app.thinking.toggle（默认 ctrl+t）：展开/收起收尾思考卡的全文 ----

	/**
	 * Pi 的 ctrl+t 只翻转 `hideThinkingBlock`，那管的是 Pi 自己的思考渲染。
	 * 本扩展接管渲染后它不再有可见效果，所以在这里把同一个键接过来。
	 * 只在 TUI 且焦点是输入框时处理：overlay 弹框（选择器、编辑器）要拿到自己的 ctrl+t。
	 */
	function toggleThinkingExpansion(): void {
		setAllThinkingExpanded(!allThinkingExpanded);
		refreshMountedTranscript(activeTui);
		activeTui?.requestRender?.(true);
	}

	let thinkingToggleUnsubscribe: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		restoreDurationEntries(ctx.sessionManager.getBranch(), completedDurations);
		activeTheme = ctx.ui.theme;
		if (ctx.mode !== "tui") return;

		// An empty widget gives the animation loop access to requestRender without
		// enabling terminal mouse reporting or intercepting native scrollback input.
		// setWidget 的 factory 同步执行，此刻补丁已安装。
		ctx.ui.setWidget(WIDGET_ID, (tui) => {
			activeTui = tui;
			return { render: () => [], invalidate() {} };
		});

		// ctrl+t 在输入框链里被 app.thinking.toggle 占用，先于编辑器判断不成立；
		// 用 onTerminalInput 在同一个键上先接管，只处理焦点在输入框的按键事件。
		if (typeof ctx.ui?.onTerminalInput === "function") {
			thinkingToggleUnsubscribe?.();
			thinkingToggleUnsubscribe = ctx.ui.onTerminalInput((data: string) => {
				if (isKeyRelease(data)) return undefined;
				const keys = thinkingToggleKeys();
				if (!keys.some((key) => matchesKey(data, key as never))) return undefined;
				if (!isComposerFocused(activeTui)) return undefined;
				toggleThinkingExpansion();
				return { consume: true };
			});
		}

		// pi 在 reload/resume 时先于 session_start 用原始原型重建聊天组件
		// （rebuildChatFromMessages / renderCurrentSessionState）。由共享的
		// refreshMountedTranscript 扫描挂载树重绘这些组件，恢复 compact 渲染、
		// 持久化时长与工具调用显示。
		refreshMountedTranscript(activeTui);
		activeTui?.requestRender(true);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreDurationEntries(ctx.sessionManager.getBranch(), completedDurations);
		refreshMountedTranscript(activeTui);
		activeTui?.requestRender(true);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		finishThinking();
		thinkingToggleUnsubscribe?.();
		thinkingToggleUnsubscribe = undefined;
		allThinkingExpanded = false;
		activeThinkingQuery = undefined;
		activeThinkingStateQuery = undefined;
		activeThinkingAnimationFrameQuery = undefined;
		activeCompactSummarySetter = undefined;
		compactSummaryActive = false;
		if (animationTimer) clearInterval(animationTimer);
		animationTimer = undefined;
		activeTui = undefined;
		activeTheme = undefined;
		latestComponent = undefined;
		latestComponentTimestamp = undefined;
		completedDurations.clear();
		streamingComponents.clear();
		expandedThinking.clear();
		collapsedThinking.clear();
		clearThinkingPreviewCache();
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_ID, undefined);

		if (patchInstalled) {
			if (prototype.updateContent === installedUpdateContent) {
				const wrappedOriginal = (originalUpdateContent as any)[PROTOTYPE_ORIGINAL_KEY];
				prototype.updateContent =
					typeof wrappedOriginal === "function" ? wrappedOriginal : originalUpdateContent;
			}
			patchInstalled = false;
		}
	});
}

type CompactThinkingOwner = {
	owner: object;
	stop(event?: any, ctx?: any): void;
};

type UpstreamHandler = (event: any, ctx: any) => void;

export function installCompactThinking(
	pi: ExtensionAPI,
	initialConfig: CompactThinkingConfig,
): CompactThinkingController {
	const owner = {};
	let session: { event: any; ctx: any } | undefined;
	let active = false;
	// Stable pi.on wrappers delegate here so activate/reload never double-binds.
	const delegates = new Map<string, UpstreamHandler>();
	const boundEvents = new Set<string>();

	const restoreAllDurations = (ctx: any): any => {
		const sessionManager = ctx?.sessionManager;
		if (!sessionManager || typeof sessionManager.getEntries !== "function") return ctx;
		return {
			...ctx,
			sessionManager: {
				...sessionManager,
				getBranch: () => sessionManager.getEntries(),
			},
		};
	};

	const bind = (eventName: string) => {
		if (boundEvents.has(eventName)) return;
		boundEvents.add(eventName);
		pi.on(eventName as any, (e: any, ctx: any) => {
			if (!active) return;
			const handler = delegates.get(eventName);
			if (!handler) return;
			handler(e, eventName === "session_tree" ? restoreAllDurations(ctx) : ctx);
		});
	};

	const stop = (event?: any, ctx?: any) => {
		if (!active) return;
		active = false;
		const shutdown = delegates.get("session_shutdown");
		delegates.clear();
		shutdown?.(event ?? session?.event ?? {}, ctx ?? session?.ctx ?? { mode: "rpc", ui: {} });
		if (patchRegistry.get<CompactThinkingOwner>(COMPACT_THINKING_OWNER)?.owner === owner)
			patchRegistry.delete(COMPACT_THINKING_OWNER);
	};

	const activate = (event: any, ctx: any) => {
		// Headless subagent runtimes share this process. Never steal the parent
		// TUI prototype patch or kill its thinking ticker.
		if (ctx?.mode !== "tui") return;

		patchRegistry.get<CompactThinkingOwner>(COMPACT_THINKING_OWNER)?.stop(event, ctx);
		session = { event, ctx };

		// 配置统一由 claude-code-style 管控，加载时覆盖库默认值。
		Object.assign(config, initialConfig);
		delegates.clear();

		compactThinking({
			on(eventName: string, handler: UpstreamHandler) {
				if (eventName === "session_start") {
					// Already inside session_start — run immediately.
					handler(event, restoreAllDurations(ctx));
					return;
				}
				if (eventName === "session_shutdown") {
					delegates.set(eventName, handler);
					return;
				}
				delegates.set(eventName, handler);
				bind(eventName);
			},
			appendEntry: (...args: any[]) => (pi.appendEntry as any)(...args),
		} as unknown as ExtensionAPI);

		active = true;
		patchRegistry.install(COMPACT_THINKING_OWNER, { owner, stop });
	};

	pi.on("session_start", (event, ctx) => {
		session = { event, ctx };
		activate(event, ctx);
	});
	pi.on("session_shutdown", (event, ctx) => {
		if (patchRegistry.get<CompactThinkingOwner>(COMPACT_THINKING_OWNER)?.owner === owner)
			stop(event, ctx);
		session = undefined;
	});

	return {
		updateConfig(next) {
			Object.assign(initialConfig, next);
			Object.assign(config, next);
		},
		getMessageThinkingDurationMs(messageTimestamp) {
			return activeThinkingQuery?.(messageTimestamp);
		},
		isMessageThinkingActive(messageTimestamp) {
			return activeThinkingStateQuery?.(messageTimestamp) ?? false;
		},
		getThinkingAnimationFrame() {
			return activeThinkingAnimationFrameQuery?.() ?? 0;
		},
		setCompactSummaryActive(active) {
			activeCompactSummarySetter?.(active);
		},
	};
}
