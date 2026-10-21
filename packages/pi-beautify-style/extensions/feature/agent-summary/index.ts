/**
 * Agent 回合摘要展示：agent_end 时把本回合工具统计写入会话条目，
 * 由 entry renderer 渲染为 markdown 引用块 `> [!TIP] *斜体内容*`。
 *
 * 统计复用 ./core.ts（bash|powershell/read/edit/write/other）。
 * appendEntry 不进 LLM 上下文，只显示在聊天区。
 * 引用块文字色取主题 mdQuote（cc 主题下为 muted 灰），内容用 *斜体* 语法。
 */

import { Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindAgentSummary, summaryMarkdown, type AgentSummaryData } from "./core.ts";

export const AGENT_SUMMARY_ENTRY_TYPE = "agent-summary";

export default function (pi: ExtensionAPI): void {
	pi.registerEntryRenderer(AGENT_SUMMARY_ENTRY_TYPE, (entry, _options, theme) => {
		const line = summaryMarkdown(entry.data as AgentSummaryData, {
			success: theme.getFgAnsi("success"),
			failed: theme.getFgAnsi("error"),
		});
		if (!line) return undefined;
		return new Markdown(line, 1, 0, getMarkdownTheme());
	});

	bindAgentSummary(pi, (data) => {
		pi.appendEntry(AGENT_SUMMARY_ENTRY_TYPE, data);
	});
}
