import type { CompactThinkingConfig } from "../feature/compact-thinking.ts";
import { DEFAULT_FOOTER_CHIP_LAYOUT } from "../feature/shell/footer-layout.ts";

export type CompactStyleMode = "on" | "compact" | "off";

export type DiffViewMode = "auto" | "split" | "unified";
export type DiffIndicatorMode = "bars" | "classic" | "none";
export type FooterGitStatsMode = "working" | "branch";
export type FooterTokenRateMode = "average" | "live";
export type ScrollButtonMode = "dock" | "native";

export interface ToolDisplayConfig {
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffSplitMinWidth: number;
	/** Edit-only collapsed body lines. 0 = change counts and an expand hint. */
	editDiffCollapsedLines: number;
	/** Write-only collapsed body lines. 0 = `↳ created · click to show more`. */
	writeDiffCollapsedLines: number;
	diffWordWrap: boolean;
	expandedPreviewMaxLines: number;
}

export const DEFAULT_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
	diffViewMode: "auto",
	diffIndicatorMode: "bars",
	diffSplitMinWidth: 120,
	/** Collapsed edit/diff body: ~half a typical terminal after chrome. */
	editDiffCollapsedLines: 24,
	/**
	 * Write create/overwrite collapsed body.
	 * 0 = `↳ created · click to show more` (stats stay on the title).
	 */
	writeDiffCollapsedLines: 0,
	diffWordWrap: true,
	/**
	 * Expanded TaskList body cap. Tool Input/Output and diffs use their own settings;
	 * an expanded diff always renders every line.
	 */
	expandedPreviewMaxLines: 40,
};

export type Config = {
	mode: CompactStyleMode;
	excludeRenderers: string[];
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffSplitMinWidth: number;
	editDiffCollapsedLines: number;
	writeDiffCollapsedLines: number;
	diffWordWrap: boolean;
	expandedPreviewMaxLines: number;
	expandedInputMaxLines: number;
	expandedOutputMaxLines: number;
	toolLabelClip: number;
	useSummaryTitlesAsThinkingTitle: boolean;
	previewLines: number;
	animationIntervalMs: number;
	/** fullscreen：userMessage 正文首行滚出视口上沿后钉住，直到下一条指令接手。 */
	stickyUserMessage: boolean;
	/** fullscreen 回到底部按钮：扩展 dock 行，或 Pi 原生浮层；两者文案相同。 */
	scrollButtonMode: ScrollButtonMode;
	enableSessionReference: boolean;
	enableSubagentAutocomplete: boolean;
	enableContextCommand: boolean;
	enableAgentSummary: boolean;
	enableWorkingMessage: boolean;
	/** markdown 转换：Mermaid 方言渲染、圈数字转半角括号。关掉让位给其他扩展。 */
	enableMarkdownEnhance: boolean;
	/** 输入框 `❯ ` 前缀（占左侧 2 列，颜色随 thinking/bash mode 联动）。 */
	enableEditorPrefix: boolean;
	enableCustomFooter: boolean;
	/** footer 输出速率芯片。关则不显示。 */
	footerTokenRate: boolean;
	/** average：整段指令墙钟平均；live：最近 1 秒瞬时速率，空档回退平均。 */
	footerTokenRateMode: FooterTokenRateMode;
	/** 速率芯片是否带 TTFT。关则只显示速率。 */
	footerTokenRateTtft: boolean;
	/** ISO 4217 显示币种。USD 时不换算。 */
	footerCurrency: string;
	/** 1 单位费用对应的显示币种数量。null 只换符号、不乘倍率。 */
	footerCurrencyRate: number | null;
	footerNerdIcons: boolean;
	footerGitStatsMode: FooterGitStatsMode;
	footerHiddenKeys: string[];
	footerLine1Keys: string[];
	footerLine2Keys: string[];
	footerLine3Keys: string[];
};

export const DIFF_VIEW_MODES: DiffViewMode[] = ["auto", "split", "unified"];
export const DIFF_INDICATOR_MODES: DiffIndicatorMode[] = ["bars", "classic", "none"];
export const FOOTER_GIT_STATS_MODES: FooterGitStatsMode[] = ["working", "branch"];
export const FOOTER_TOKEN_RATE_MODES: FooterTokenRateMode[] = ["average", "live"];
export const SCROLL_BUTTON_MODES: ScrollButtonMode[] = ["dock", "native"];
export const DIFF_SPLIT_MIN_WIDTH_VALUES = ["80", "100", "120", "140", "160", "180"];
export const DIFF_COLLAPSED_LINES_VALUES = ["0", "12", "24", "36", "48", "80", "120"];
/** Write collapsed presets. 0 = stats only (`+N -0` + expand hint). */
export const WRITE_DIFF_COLLAPSED_LINES_VALUES = ["0", "4", "8", "12", "24", "36"];
/** Presets for expanded body height — keep low options first so cycling stays TUI-friendly. */
export const EXPANDED_PREVIEW_MAX_LINES_VALUES = ["40", "60", "80", "120", "200", "500", "2000"];
/** 展开工具卡 Input 可见行数预设。 */
export const EXPANDED_INPUT_MAX_LINES_VALUES = ["5", "10", "20", "40", "80"];
/** 展开工具卡 Output 可见行数预设。 */
export const EXPANDED_OUTPUT_MAX_LINES_VALUES = ["10", "20", "40", "80", "120"];
/** 工具摘要里 path/command 等输入的折叠字符数；0 = 只按可用宽度截断。 */
export const TOOL_LABEL_CLIP_VALUES = ["0", "40", "60", "80", "100", "120", "160"];
export const THINKING_PREVIEW_LINES_VALUES = ["0", "1", "3", "5", "10"];
export const THINKING_ANIMATION_INTERVAL_VALUES = ["40", "60", "90", "120", "180"];
/** Tools commonly excluded from ccstyle rendering. */
export const EXCLUDE_RENDERER_CANDIDATES = [
	"bash",
	"powershell",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"webfetch",
	"wait",
];

export const DEFAULT_CONFIG: Config = {
	mode: "on",
	excludeRenderers: [],
	diffViewMode: DEFAULT_TOOL_DISPLAY_CONFIG.diffViewMode,
	diffIndicatorMode: DEFAULT_TOOL_DISPLAY_CONFIG.diffIndicatorMode,
	diffSplitMinWidth: DEFAULT_TOOL_DISPLAY_CONFIG.diffSplitMinWidth,
	editDiffCollapsedLines: DEFAULT_TOOL_DISPLAY_CONFIG.editDiffCollapsedLines,
	writeDiffCollapsedLines: DEFAULT_TOOL_DISPLAY_CONFIG.writeDiffCollapsedLines,
	diffWordWrap: DEFAULT_TOOL_DISPLAY_CONFIG.diffWordWrap,
	expandedPreviewMaxLines: DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
	expandedInputMaxLines: 5,
	expandedOutputMaxLines: 10,
	toolLabelClip: 0,
	useSummaryTitlesAsThinkingTitle: true,
	previewLines: 3,
	animationIntervalMs: 90,
	stickyUserMessage: true,
	scrollButtonMode: "dock",
	enableSessionReference: true,
	enableSubagentAutocomplete: true,
	enableContextCommand: true,
	enableAgentSummary: true,
	enableWorkingMessage: true,
	enableMarkdownEnhance: true,
	enableEditorPrefix: true,
	enableCustomFooter: true,
	footerTokenRate: true,
	footerTokenRateMode: "average",
	footerTokenRateTtft: true,
	footerCurrency: "USD",
	footerCurrencyRate: null,
	footerNerdIcons: true,
	footerGitStatsMode: "working",
	...DEFAULT_FOOTER_CHIP_LAYOUT,
};

/**
 * Source constants for the render and feature switches.
 *
 * This package has no runtime configuration surface: no `/ccstyle` command, no
 * settings panel, no JSON file. The object is mutable only so tests can
 * override fields; production code must treat it as read-only. Edit
 * `DEFAULT_CONFIG` and restart Pi to change behavior.
 */
export const config: Config = { ...DEFAULT_CONFIG };

export function getCompactThinkingConfig(source: Config = config): CompactThinkingConfig {
	return {
		useSummaryTitlesAsThinkingTitle: source.useSummaryTitlesAsThinkingTitle,
		previewLines: source.previewLines,
		animationIntervalMs: source.animationIntervalMs,
	};
}

export function getToolDisplayConfig(source: Config = config): ToolDisplayConfig {
	return {
		diffViewMode: source.diffViewMode,
		diffIndicatorMode: source.diffIndicatorMode,
		diffSplitMinWidth: source.diffSplitMinWidth,
		editDiffCollapsedLines: source.editDiffCollapsedLines,
		writeDiffCollapsedLines: source.writeDiffCollapsedLines,
		diffWordWrap: source.diffWordWrap,
		expandedPreviewMaxLines: source.expandedPreviewMaxLines,
	};
}

