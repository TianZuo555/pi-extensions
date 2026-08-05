import type { Component } from "@earendil-works/pi-tui";
import { Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { capUntrustedText, lastSanitizedLines } from "./sanitize-text.ts";

const COMPACT_REASON_LINE_COUNT = 5;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

type ThemeLike = {
  fg(color: "border" | "accent" | "thinkingText", text: string): string;
  italic(text: string): string;
};

const THEME_SYMBOL = Symbol.for("@earendil-works/pi-coding-agent:theme");
const OLD_THEME_SYMBOL = Symbol.for("@mariozechner/pi-coding-agent:theme");

function getTheme(): ThemeLike | undefined {
  const globals = globalThis as Record<symbol, unknown>;
  const current = globals[THEME_SYMBOL] ?? globals[OLD_THEME_SYMBOL];
  if (!current || typeof current !== "object") return undefined;
  const theme = current as Partial<ThemeLike>;
  if (typeof theme.fg !== "function" || typeof theme.italic !== "function") {
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

function thinkingLines(
  thinking: string,
  expanded: boolean,
  lineCount: number,
): string[] {
  const capped = capUntrustedText(thinking);
  if (expanded) {
    return capped
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
  }
  return lastSanitizedLines(capped, lineCount);
}

export interface CompactReasoningPreview {
  lines: string[];
  segmentIndex: number;
}

export function buildCompactReasoningPreview(
  thinking: string,
  segmentIndex: number,
  previous?: CompactReasoningPreview,
  lineCount: number = COMPACT_REASON_LINE_COUNT,
): CompactReasoningPreview | undefined {
  const latestLines = lastSanitizedLines(thinking, lineCount);
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
  private streaming = false;
  private frame = 0;
  private requestRender?: () => void;
  private interval?: ReturnType<typeof setInterval>;
  private lineCount = COMPACT_REASON_LINE_COUNT;

  updateContent(
    thinking: string | undefined,
    preview: CompactReasoningPreview | undefined,
    expanded: boolean,
    lineCount: number = COMPACT_REASON_LINE_COUNT,
  ): void {
    this.thinking = thinking;
    this.preview = preview;
    this.expanded = expanded;
    this.lineCount = lineCount;
    if (thinking === undefined || thinking.trim() === "") {
      this.setStreaming(false);
    }
  }

  /** Toggle the animated loading sign. `requestRender` is captured once and
   * drives the spinner at a steady cadence; without it the frame advances on
   * each render (streaming chunks re-render the transcript anyway). */
  setStreaming(streaming: boolean, requestRender?: () => void): void {
    this.streaming = streaming;
    if (requestRender) {
      this.requestRender = requestRender;
    }
    if (streaming) {
      if (this.requestRender && !this.interval) {
        this.interval = setInterval(() => {
          this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
          this.requestRender?.();
        }, SPINNER_INTERVAL_MS);
      }
    } else {
      if (this.interval) {
        clearInterval(this.interval);
        this.interval = undefined;
      }
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.thinking?.trim()) {
      return [];
    }

    const lines = this.expanded
      ? thinkingLines(this.thinking, true, this.lineCount)
      : (this.preview?.lines ?? thinkingLines(this.thinking, false, this.lineCount));
    if (lines.length === 0) {
      return [];
    }

    if (this.streaming && !this.interval) {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
    }

    const safeWidth = Math.max(1, Math.floor(width));
    const theme = getTheme();
    const border = (text: string) => (theme ? theme.fg("border", text) : text);
    const accent = (text: string) => (theme ? theme.fg("accent", text) : text);

    const spinner = this.streaming ? accent(SPINNER_FRAMES[this.frame] ?? "") : "";
    const label = ` Reasoning${spinner ? ` ${spinner}` : ""} `;
    const innerWidth = Math.max(1, safeWidth - 2);
    const topDashes = Math.max(0, innerWidth - visibleWidth(label));
    const top = truncateToWidth(
      border("╭") + label + border("─".repeat(topDashes) + "╮"),
      safeWidth,
    );

    const contentWidth = Math.max(1, safeWidth - 4);
    const contentLines = lines.map((line) => {
      const formatted = formatReasonLine(line, contentWidth);
      const padding = Math.max(0, contentWidth - visibleWidth(formatted));
      return border("│ ") + formatted + " ".repeat(padding) + border(" │");
    });

    const bottom = border("╰") + border("─".repeat(innerWidth) + "╯");

    const topSpacer = new Spacer(1);
    const bottomSpacer = new Spacer(1);
    return [
      ...topSpacer.render(safeWidth),
      top,
      ...contentLines,
      bottom,
      ...bottomSpacer.render(safeWidth),
    ];
  }
}
