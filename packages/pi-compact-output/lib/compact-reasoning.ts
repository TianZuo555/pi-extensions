import type { Component } from "@earendil-works/pi-tui";
import {
  Spacer,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "./compact-status.ts";
import { capUntrustedText, lastSanitizedLines } from "./sanitize-text.ts";

const COMPACT_REASON_LINE_COUNT = 5;
const BOLD_REASONING_LINE = /^\s*\*\*(.*?)\*\*\s*$/u;

/**
 * Remove the lightweight bold wrappers emitted by some reasoning providers.
 * This only changes the presentation copy; the assistant message remains raw.
 */
export function normalizeReasoningText(thinking: string): string {
  const lines = capUntrustedText(thinking).split(/\r?\n/u).map((line) => {
    const match = BOLD_REASONING_LINE.exec(line);
    return match ? match[1]?.trim() ?? "" : line;
  });

  const firstContent = lines.findIndex((line) => line.trim().length > 0);
  let lastContent = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]?.trim().length) {
      lastContent = index;
      break;
    }
  }
  if (firstContent >= 0 && lastContent > firstContent) {
    const first = lines[firstContent] ?? "";
    const last = lines[lastContent] ?? "";
    if (first.trimStart().startsWith("**") && last.trimEnd().endsWith("**")) {
      lines[firstContent] = first.replace(/^(\s*)\*\*\s?/u, "$1");
      lines[lastContent] = last.replace(/\s?\*\*(\s*)$/u, "$1");
    }
  }

  return lines.join("\n");
}

type ThemeLike = {
  fg(color: "text" | "accent" | "success" | "thinkingText", text: string): string;
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
  const capped = normalizeReasoningText(thinking);
  if (expanded) {
    // Keep explicit blank lines in the expanded view so paragraph breaks in
    // long reasoning remain visible after each logical line is wrapped.
    return capped.split("\n").map((line) => line.trimEnd());
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
  const latestLines = lastSanitizedLines(normalizeReasoningText(thinking), lineCount);
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

    const safeWidth = Math.max(1, Math.floor(width));
    const contentWidth = Math.max(1, safeWidth - 4);
    const wrappedLines = lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth));

    if (this.streaming && !this.interval) {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
    }

    const theme = getTheme();
    // Keep the reasoning frame readable against dimmer border colors.
    const border = (text: string) => (theme ? theme.fg("text", text) : text);
    const accent = (text: string) => (theme ? theme.fg("accent", text) : text);
    const success = (text: string) => (theme ? theme.fg("success", text) : text);

    const status = this.streaming
      ? accent(SPINNER_FRAMES[this.frame] ?? "")
      : success("✓");
    const label = ` Reasoning ${status} `;
    const innerWidth = Math.max(1, safeWidth - 2);
    const topDashes = Math.max(0, innerWidth - visibleWidth(label));
    const top = truncateToWidth(
      border("╭") + label + border("─".repeat(topDashes) + "╮"),
      safeWidth,
    );

    const contentLines = wrappedLines.map((line) => {
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
