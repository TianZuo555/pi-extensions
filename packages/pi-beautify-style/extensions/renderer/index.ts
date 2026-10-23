import { ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompactThinkingController } from "../feature/compact-thinking.ts";
import { installToolGrouping, type ToolGroupingHooks } from "./tool/grouping.ts";
import {
	installCompactMode,
	refreshCompactModeComponents,
	type CompactModeHooks,
	type CompactThinkingQuery,
} from "./compact-mode.ts";
import {
	installDefaultMode,
	installToolExpandedBackground,
	type DefaultModeHooks,
} from "./default-mode.ts";
import { installMainScreenDoRenderPatch, isLazyProxyTui } from "../utils/fullscreen-detect.ts";
import { config } from "../config/config.ts";
import {
	installToolMouseInteraction,
	resetToolHoverState,
	scheduleSessionRender,
	teardownToolMouseInteraction,
	TOOL_MOUSE_DISABLE,
} from "./mouse/interaction.ts";
import { getToolMouseTui, noteNewTranscriptItem } from "./mouse/scroll.ts";
import {
	disposeStickyPromptPatches,
	installStickyPromptPatches,
	setStickyPromptTheme,
} from "./mouse/sticky-prompt.ts";
import { setHoveredToolGroup, setHoveredToolIo } from "./mouse/hover.ts";
import {
	clearAllAnimations,
	clearLiveToolCalls,
	noteStreamingToolCalls,
	retireLiveToolCall,
} from "./tool/tool-state.ts";
import { installWriteOverride, WriteExecutionMetadataStore } from "./tool/diff/index.ts";
import {
	installMessageDisplayRendering,
	refreshMessageDisplays,
	setMessageDisplayTheme,
} from "./tool/message-display.ts";

/**
 * Claude Code Style for pi — 装配入口。
 *
 * mode=on      → default-mode（工具卡样式 + 展开背景）
 * mode=compact → compact-mode（消息折叠摘要）
 * 共用        → tool-grouping / message-display / mouse / write override
 */

let compactModeHooks: CompactModeHooks | undefined;

function refreshCurrentTranscript(ctx?: any, toolGrouping?: ToolGroupingHooks): void {
	const tui = getToolMouseTui();
	toolGrouping?.refresh(tui);
	refreshMessageDisplays(tui);
	refreshCompactModeComponents(tui);
	compactModeHooks?.refresh();
	tui?.requestRender?.(true);
	ctx?.ui?.requestRender?.(true);
}

function syncCompactMode(ctx: any): void {
	refreshCompactModeComponents(getToolMouseTui());
	compactModeHooks?.sync(ctx);
}

export default function (
	pi: ExtensionAPI,
	compactThinking?: CompactThinkingController,
) {
	const writeExecutionMetadata = new WriteExecutionMetadataStore();
	const mouseOwner = {};
	let installation:
		| {
				defaultMode: DefaultModeHooks;
				toolGrouping: ToolGroupingHooks;
				compactMode: CompactModeHooks;
				disposeMessageDisplay: () => void;
				disposeToolExpandedBackground: () => void;
		  }
		| undefined;

	const ensureTuiInstallation = (ctx: any) => {
		if (ctx?.mode !== "tui" || !ctx?.hasUI) return undefined;
		// 渲染层（工具样式/分组）是原型与组件级 patch，fullscreen 官方布局
		// 同样渲染这些组件，因此两种模式都安装。
		if (installation) return installation;
		// regular 主屏的差分渲染补丁：视口上方变化不再触发清回滚的 fullRender。
		installMainScreenDoRenderPatch();
		// 粘性用户消息头：标记注入 + fullscreen 帧合成。
		installStickyPromptPatches();
		const defaultMode = installDefaultMode(writeExecutionMetadata);
		const toolGrouping = installToolGrouping(() => config.mode === "on");
		const compactMode = installCompactMode({
			query: compactThinking as CompactThinkingQuery | undefined,
			writeMetadata: writeExecutionMetadata,
		});
		compactModeHooks = compactMode;
		const disposeMessageDisplay = installMessageDisplayRendering();
		// 展开背景必须在 compact-mode 之后装，shutdown 时先于 compact 释放。
		const disposeToolExpandedBackground = installToolExpandedBackground();
		installation = {
			defaultMode,
			toolGrouping,
			compactMode,
			disposeMessageDisplay,
			disposeToolExpandedBackground,
		};
		return installation;
	};

	pi.on("message_update", async (event) => {
		// 声明期（assistant 消息结束前）就记住工具 id：这段工具行已在等启动，
		// spinner 该转，但 Pi 还没跑 markExecutionStarted。
		if (event.message?.role === "assistant") noteStreamingToolCalls(event.message);
		// compact-thinking 在 session_start 时于 compact 补丁之上再装一层；
		// 扩展事件先于 interactive-mode 的 updateContent 派发，此处先重新认领。
		if (config.mode === "compact" && event.message?.role === "assistant") {
			compactModeHooks?.assertOwnership();
		}
	});

	// 回到底部按钮的累计计数：离开底部期间每落一块内容 +1。
	pi.on("message_start", async (event) => {
		const role = event.message?.role;
		// toolResult 不单独成块（渲染在工具卡内），跳过以免与工具卡重复计数。
		if (role === "user" || role === "assistant" || role === "custom") noteNewTranscriptItem();
	});

	pi.on("tool_execution_end", async (event) => {
		retireLiveToolCall(event?.toolCallId);
		if (config.mode !== "compact") return;
		// Agent 等工具收尾后延迟刷新，让 compact-thinking 先落最终态。
		const toolCallId: string | undefined = event?.toolCallId;
		setTimeout(() => {
			compactModeHooks?.refreshToolCallMessage(toolCallId);
		}, 0);
	});

	pi.on("session_start", async (event, ctx) => {
		// 延后一拍再确认 write 归属：其他扩展同样在各自的 session_start 里注册工具，
		// 本 handler 执行时可能还看不到对方，此时注册会与对方撞名（注册表先到先得），
		// 对方的 write 会被静默丢弃。等所有 session_start 跑完，检测结果才是权威的。
		setTimeout(() => {
			installWriteOverride(pi, writeExecutionMetadata, (owner) => {
				// 冲突可见：对方接管 write 后本插件不再提供富 diff。
				ctx.ui?.notify?.(
					`ccstyle: write 工具已被 ${owner.path || owner.source} 占用，富 diff 已让位`,
					"warning",
				);
			});
		}, 0);
		const hooks = ensureTuiInstallation(ctx);
		// 鼠标交互独立于渲染层：fullscreen 渲染层让位（hooks undefined）但
		// 工具点击/回到底部适配仍需安装；保持在渲染层安装之后以维持原顺序。
		if (ctx?.mode === "tui" && ctx?.hasUI) installToolMouseInteraction(ctx, mouseOwner);
		if (!hooks) return;
		hooks.toolGrouping.setTheme(ctx.ui.theme);
		setMessageDisplayTheme(ctx.ui.theme);
		setStickyPromptTheme(ctx.ui.theme);
		ctx.ui.setStatus("ccstyle", undefined);
		// 先收集 resume transcript，再同步 compact 补丁与全局展开状态。
		syncCompactMode(ctx);
		// compact-thinking 的 session_start 处理在本 handler 之后执行（在其之上再装
		// 一层 updateContent）；延迟再同步一次，保证 compact 补丁最终位于外层。
		setTimeout(() => syncCompactMode(ctx), 0);
		// 历史回放发生在 session_start 之后，延迟到回放结束再收尾最后一个回合，
		// 否则它没有后续消息，摘要行会停在 Running。
		setTimeout(() => compactModeHooks?.settleReplayedRound(), 0);
		scheduleSessionRender(() => hooks.toolGrouping.refresh(getToolMouseTui()));
	});

	pi.on("session_compact", async (event, ctx) => {
		const hooks = ensureTuiInstallation(ctx);
		// Compaction rebuilds the transcript without session_start. Rebind after
		// other TUI extensions may have replaced the root input dispatcher.
		if (ctx?.mode === "tui" && ctx?.hasUI) installToolMouseInteraction(ctx, mouseOwner);
		if (!hooks) return;
		hooks.toolGrouping.setTheme(ctx.ui.theme);
		setMessageDisplayTheme(ctx.ui.theme);
		setStickyPromptTheme(ctx.ui.theme);
		syncCompactMode(ctx);
		scheduleSessionRender(() => {
			syncCompactMode(ctx);
			hooks.toolGrouping.refresh(getToolMouseTui());
		});
	});

	pi.on("session_tree", async (event, ctx) => {
		// 会话树重建后在当前帧和下一帧各同步一次，替换旧组件引用。
		if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
		syncCompactMode(ctx);
		scheduleSessionRender(() => syncCompactMode(ctx));
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		installation?.toolGrouping.setTheme(ctx.ui.theme);
		noteNewTranscriptItem();
	});

	pi.on("turn_end", async () => {
		clearLiveToolCalls();
	});

	pi.on("agent_end", async () => {
		clearLiveToolCalls();
	});

	pi.on("session_shutdown", async () => {
		writeExecutionMetadata.clear();
		// 会话结束就清空，不能等 installation 早退判断；残留的 id 会让下一会话误转。
		clearLiveToolCalls();
		// 鼠标交互独立于渲染层：fullscreen 下 installation 为 undefined，
		// 但 onTerminalInput 监听与 handleViewportInput 包装仍需释放。
		teardownToolMouseInteraction(mouseOwner);
		const current = installation;
		if (!current || !current.defaultMode.isOwner()) return;
		current.defaultMode.shutdown();
		current.toolGrouping.shutdown();
		current.disposeToolExpandedBackground();
		current.compactMode.shutdown();
		compactModeHooks = undefined;
		current.disposeMessageDisplay();
		disposeStickyPromptPatches();
		clearAllAnimations();
		installation = undefined;
	});
}

// ---- 对外导出：入口/测试实际消费的符号 ----
export { getCompactThinkingConfig } from "../config/config.ts";
export {
	preservesOriginalRenderer,
	shouldRenderRichDiff,
} from "./default-mode.ts";
export {
	isMcpToolDefinition,
	mcpToolTitle,
} from "./tool/mcp-title.ts";
export {
	ExpandedToolIoView,
	ExpandedToolResultText,
	formatToolInputArgs,
} from "./tool/tool-io.ts";
export { SHOW_MORE_LABEL } from "./tool/result.ts";
export { installToolMouseInteraction } from "./mouse/interaction.ts";
