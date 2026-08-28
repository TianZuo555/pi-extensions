import { Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  buildCompactToolLine,
  compactToolStatusMarker,
  getCompactToolStatus,
  type ToolExecutionInternals,
} from "./compact-tool-line.ts";
import type { CompactToolStatus } from "./compact-status.ts";

export interface CompactToolGroupItem {
  internals: ToolExecutionInternals;
}

type ToolBorderColor = "accent" | "border" | "success" | "error";
type ThemeLike = {
  fg(color: ToolBorderColor, text: string): string;
};

const THEME_SYMBOL = Symbol.for("@earendil-works/pi-coding-agent:theme");
const OLD_THEME_SYMBOL = Symbol.for("@mariozechner/pi-coding-agent:theme");

function getTheme(): ThemeLike | undefined {
  const globals = globalThis as Record<symbol, unknown>;
  const current = globals[THEME_SYMBOL] ?? globals[OLD_THEME_SYMBOL];
  if (!current || typeof current !== "object") return undefined;
  const theme = current as Partial<ThemeLike>;
  return typeof theme.fg === "function" ? (theme as ThemeLike) : undefined;
}

function groupStatus(items: readonly CompactToolGroupItem[]): CompactToolStatus {
  if (items.some((item) => getCompactToolStatus(item.internals) === "pending")) {
    return "pending";
  }
  if (items.some((item) => getCompactToolStatus(item.internals) === "error")) {
    return "error";
  }
  return "success";
}

function statusBorderColor(status: CompactToolStatus): ToolBorderColor {
  switch (status) {
    case "pending":
      return "accent";
    case "error":
      return "error";
    case "success":
      return "success";
  }
}

/**
 * Render a consecutive tool sequence as one bordered status block with its
 * status sign in the top-left label. Items arrive in execution order.
 * Collapsed, the block shows the last
 * tool's call and up to `lineCount` lines of its result; Ctrl+O expands each
 * tool to its original renderer in execution order (first to last).
 */
export function buildCompactToolGroup(
  items: readonly CompactToolGroupItem[],
  width: number,
  lineCount: number = 3,
  spinnerFrame: number = 0,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const last = items[items.length - 1];
  if (!last) {
    return [];
  }

  const status = groupStatus(items);
  const contentWidth = Math.max(1, safeWidth - 4);
  const lineParts = buildCompactToolLine(last.internals, contentWidth, lineCount, {
    status,
    spinnerFrame,
    showStatusMarker: false,
  });
  if (lineParts.length === 0) {
    return [];
  }

  const contentLines = lineParts
    .slice(0, lineCount)
    .map((line) => truncateToWidth(line, contentWidth));
  if (contentLines.length > 0 && items.length > 1) {
    // Keep the overflow count visible after the configured preview lines
    // instead of truncating it onto the last tool/result line.
    contentLines.push(truncateToWidth(`· +${items.length - 1} more`, contentWidth));
  }

  const theme = getTheme();
  const borderColor = statusBorderColor(status);
  const border = (text: string) => (theme ? theme.fg(borderColor, text) : text);
  const marker = compactToolStatusMarker(status, spinnerFrame);
  const styledMarker = theme ? theme.fg(borderColor, marker) : marker;
  const innerWidth = Math.max(0, safeWidth - 2);
  const label = ` Tool ${styledMarker} `;
  const topDashes = Math.max(0, innerWidth - visibleWidth(label));
  const top = truncateToWidth(border("╭") + label + border(`${"─".repeat(topDashes)}╮`), safeWidth);

  const renderedContent = contentLines.map((line) => {
    const padding = Math.max(0, contentWidth - visibleWidth(line));
    return truncateToWidth(border("│ ") + line + " ".repeat(padding) + border(" │"), safeWidth);
  });
  const bottom = truncateToWidth(border("╰") + border(`${"─".repeat(innerWidth)}╯`), safeWidth);

  const topSpacer = new Spacer(1);
  const bottomSpacer = new Spacer(1);
  return [
    ...topSpacer.render(safeWidth),
    top,
    ...renderedContent,
    bottom,
    ...bottomSpacer.render(safeWidth),
  ];
}
