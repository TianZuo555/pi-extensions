import { Box, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
  buildCompactToolLine,
  type ToolExecutionInternals,
} from "./compact-tool-line.ts";

export interface CompactToolGroupItem {
  internals: ToolExecutionInternals;
}

type ToolBackground = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
type ThemeLike = {
  bg(color: ToolBackground, text: string): string;
};

const THEME_SYMBOL = Symbol.for("@earendil-works/pi-coding-agent:theme");
const OLD_THEME_SYMBOL = Symbol.for("@mariozechner/pi-coding-agent:theme");

function getTheme(): ThemeLike | undefined {
  const globals = globalThis as Record<symbol, unknown>;
  const current = globals[THEME_SYMBOL] ?? globals[OLD_THEME_SYMBOL];
  if (!current || typeof current !== "object") return undefined;
  const theme = current as Partial<ThemeLike>;
  return typeof theme.bg === "function" ? (theme as ThemeLike) : undefined;
}

function groupBackground(items: readonly CompactToolGroupItem[]): ToolBackground {
  if (items.some((item) => item.internals.isPartial)) {
    return "toolPendingBg";
  }
  if (items.some((item) => item.internals.result?.isError)) {
    return "toolErrorBg";
  }
  return "toolSuccessBg";
}

/**
 * Render a consecutive tool sequence as one padded, background-filled area.
 * Items arrive in execution order. Collapsed, the whole group is a single
 * line: the last tool's call and a `· +N more` count. Ctrl+O expands each
 * tool to its original renderer in execution order (first to last).
 */
export function buildCompactToolGroup(
  items: readonly CompactToolGroupItem[],
  width: number,
  lineCount: number = 3,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const paddingX = safeWidth >= 3 ? 1 : 0;
  const contentWidth = Math.max(1, safeWidth - paddingX * 2);
  const last = items[items.length - 1];
  if (!last) {
    return [];
  }

  const lineParts = buildCompactToolLine(last.internals, contentWidth, lineCount);
  if (lineParts.length === 0) {
    return [];
  }

  const contentLines = lineParts.slice(0, lineCount);
  if (contentLines.length > 0 && items.length > 1) {
    const lastIndex = contentLines.length - 1;
    contentLines[lastIndex] = truncateToWidth(
      `${contentLines[lastIndex]} · +${items.length - 1} more`,
      contentWidth,
    );
  } else {
    for (let i = 0; i < contentLines.length; i++) {
      contentLines[i] = truncateToWidth(contentLines[i], contentWidth);
    }
  }

  const theme = getTheme();
  const box = new Box(
    paddingX,
    1,
    theme ? (text) => theme.bg(groupBackground(items), text) : undefined,
  );
  for (const line of contentLines) {
    box.addChild(new Text(line, 0, 0));
  }

  // One blank line above and below keeps the block visually separated from
  // the surrounding transcript text without wasting vertical space.
  const topSpacer = new Spacer(1);
  const bottomSpacer = new Spacer(1);
  return [...topSpacer.render(safeWidth), ...box.render(safeWidth), ...bottomSpacer.render(safeWidth)];
}
