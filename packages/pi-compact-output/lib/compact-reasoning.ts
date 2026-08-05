import type { Component } from "@earendil-works/pi-tui";
import { Box, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { capUntrustedText, firstSanitizedLines } from "./sanitize-text.ts";

const COMPACT_REASON_LINE_COUNT = 3;

type ThemeLike = {
  bg(color: "toolSuccessBg", text: string): string;
  fg(color: "thinkingText", text: string): string;
  italic(text: string): string;
};

const THEME_SYMBOL = Symbol.for("@earendil-works/pi-coding-agent:theme");
const OLD_THEME_SYMBOL = Symbol.for("@mariozechner/pi-coding-agent:theme");

function getTheme(): ThemeLike | undefined {
  const globals = globalThis as Record<symbol, unknown>;
  const current = globals[THEME_SYMBOL] ?? globals[OLD_THEME_SYMBOL];
  if (!current || typeof current !== "object") return undefined;
  const theme = current as Partial<ThemeLike>;
  if (
    typeof theme.bg !== "function" ||
    typeof theme.fg !== "function" ||
    typeof theme.italic !== "function"
  ) {
    return undefined;
  }
  return theme as ThemeLike;
}

function formatReasonLine(text: string, width: number): string {
  const theme = getTheme();
  const truncated = truncateToWidth(text, width);
  if (!theme) return truncated;
  return theme.italic(theme.fg("thinkingText", truncated));
}

function thinkingLines(thinking: string, expanded: boolean): string[] {
  const capped = capUntrustedText(thinking);
  if (expanded) {
    return capped
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
  }
  return firstSanitizedLines(capped, COMPACT_REASON_LINE_COUNT);
}

export interface CompactReasoningPreview {
  lines: string[];
  segmentIndex: number;
}

export function buildCompactReasoningPreview(
  thinking: string,
  segmentIndex: number,
  previous?: CompactReasoningPreview,
): CompactReasoningPreview | undefined {
  const latestLines = firstSanitizedLines(thinking, COMPACT_REASON_LINE_COUNT);
  if (latestLines.length === 0) {
    return previous?.segmentIndex === segmentIndex ? previous : undefined;
  }
  return { segmentIndex, lines: latestLines };
}

/** Renders compact or expanded reasoning for one thinking segment. */
export class CompactReasoningComponent implements Component {
  private thinking?: string;
  private preview: CompactReasoningPreview | undefined;
  private expanded = false;

  updateContent(thinking: string | undefined, preview: CompactReasoningPreview | undefined, expanded: boolean): void {
    this.thinking = thinking;
    this.preview = preview;
    this.expanded = expanded;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.thinking?.trim()) {
      return [];
    }

    const lines = this.expanded
      ? thinkingLines(this.thinking, true)
      : (this.preview?.lines ?? thinkingLines(this.thinking, false));
    if (lines.length === 0) {
      return [];
    }

    const safeWidth = Math.max(1, Math.floor(width));
    const paddingX = safeWidth >= 3 ? 1 : 0;
    const contentWidth = Math.max(1, safeWidth - paddingX * 2);
    const theme = getTheme();
    const box = new Box(
      paddingX,
      1,
      theme ? (text) => theme.bg("toolSuccessBg", text) : undefined,
    );
    for (const line of lines) {
      box.addChild(new Text(formatReasonLine(line, contentWidth), 0, 0));
    }

    const topSpacer = new Spacer(1);
    const bottomSpacer = new Spacer(1);
    return [...topSpacer.render(safeWidth), ...box.render(safeWidth), ...bottomSpacer.render(safeWidth)];
  }
}
