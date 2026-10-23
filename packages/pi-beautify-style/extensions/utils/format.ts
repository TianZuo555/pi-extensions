import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeToolResultText } from "./tool-result-sanitize.ts";

/** token/计数缩写：<1k 原数，<1M 用 k，≥1M 用 M。footer 与 working message 共用。 */
export function formatTokenCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

/** 毫秒 → "1h 2m 3s"/"2m 3s"/"3s"；低于 1 秒返回 ""（省略）。 */
export function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 1) return "";
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** 文本单行化：去换行空白，超宽截断加省略号。 */
export function oneLine(value: unknown, max = 96): string {
	const text = sanitizeToolResultText(String(value ?? ""), 4096)
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 把一行文本补齐到固定可见宽度，超宽时截断并追加省略号。 */
export function padLine(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}
