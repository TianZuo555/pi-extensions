import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { firstSanitizedLine, firstSanitizedLines, sanitizeCompactText } from "./sanitize-text.ts";

export interface ToolExecutionInternals {
  toolName: string;
  args: unknown;
  callRendererComponent?: Component;
  resultRendererComponent?: Component;
  isPartial: boolean;
  result?: {
    isError?: boolean;
    content?: Array<{
      type: string;
      text?: string;
    }>;
  };
  hideComponent?: boolean;
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function trimTrailingPaddingPreservingAnsi(line: string): string {
  return line.replace(/[ \t]+$/u, "");
}

function isVisuallyNonEmpty(line: string): boolean {
  return stripAnsi(trimTrailingPaddingPreservingAnsi(line)).trim().length > 0;
}

function firstNonEmptyRenderedLine(component: Component | undefined, width: number): string | undefined {
  return firstNonEmptyRenderedLines(component, width, 1)[0];
}

function firstNonEmptyRenderedLines(
  component: Component | undefined,
  width: number,
  count: number,
): string[] {
  if (!component || count <= 0) return [];
  const lines = component.render(width);
  const picked: string[] = [];
  for (const line of lines) {
    const trimmed = trimTrailingPaddingPreservingAnsi(line);
    if (!isVisuallyNonEmpty(trimmed)) continue;
    picked.push(trimmed);
    if (picked.length >= count) break;
  }
  return picked;
}

export { firstNonEmptyRenderedLine, firstNonEmptyRenderedLines };


function readStringField(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const sanitized = sanitizeCompactText(value);
  return sanitized || undefined;
}

export function fallbackToolSummary(toolName: string, args: unknown): string {
  switch (toolName) {
    case "bash": {
      const command = readStringField(args, "command");
      return command ?? toolName;
    }
    case "read":
    case "write":
    case "edit": {
      const path = readStringField(args, "path");
      return path ? `${toolName} ${path}` : toolName;
    }
    case "grep":
    case "ffgrep": {
      const pattern = readStringField(args, "pattern");
      const path = readStringField(args, "path");
      if (pattern && path) return `grep ${pattern} in ${path}`;
      if (pattern) return `grep ${pattern}`;
      return toolName;
    }
    case "find":
    case "fffind": {
      const pattern = readStringField(args, "pattern");
      const path = readStringField(args, "path");
      if (pattern && path) return `find ${pattern} in ${path}`;
      if (pattern) return `find ${pattern}`;
      return toolName;
    }
    case "web_search": {
      const query = readStringField(args, "query");
      return query ? `web_search ${query}` : toolName;
    }
    case "web_fetch": {
      const url = readStringField(args, "url");
      return url ? `web_fetch ${url}` : toolName;
    }
    case "todo": {
      const operation = readStringField(args, "operation");
      return operation ? `todo ${operation}` : toolName;
    }
    case "mcp": {
      const tool = readStringField(args, "tool");
      const action = readStringField(args, "action");
      if (tool) return `mcp ${tool}`;
      if (action) return `mcp ${action}`;
      return toolName;
    }
    default:
      return toolName;
  }
}

const TOOL_EMOJI = "🔧";

function toolMarker(): string {
  return TOOL_EMOJI;
}

function firstErrorLine(internals: ToolExecutionInternals): string | undefined {
  if (!internals.result?.isError || !internals.result.content) return undefined;
  for (const block of internals.result.content) {
    if (block.type !== "text" || !block.text) continue;
    const line = firstSanitizedLine(block.text);
    if (line) return line;
  }
  return undefined;
}

function firstResultLines(internals: ToolExecutionInternals, limit: number): string[] {
  if (limit <= 0 || !internals.result?.content) return [];
  const lines: string[] = [];
  for (const block of internals.result.content) {
    if (block.type !== "text" || !block.text) continue;
    for (const line of firstSanitizedLines(block.text, limit - lines.length)) {
      lines.push(line);
      if (lines.length >= limit) return lines;
    }
  }
  return lines;
}

const COMPACT_TOOL_LINE_COUNT = 3;

export function buildCompactToolLine(internals: ToolExecutionInternals, width: number): string[] {
  if (internals.hideComponent) {
    return [];
  }

  const descriptionLines = firstNonEmptyRenderedLines(
    internals.callRendererComponent,
    width,
    COMPACT_TOOL_LINE_COUNT,
  );
  if (descriptionLines.length === 0) {
    descriptionLines.push(fallbackToolSummary(internals.toolName, internals.args));
  }

  const lines: string[] = [];
  for (let i = 0; i < descriptionLines.length && lines.length < COMPACT_TOOL_LINE_COUNT; i++) {
    const prefix = i === 0 ? `${toolMarker()} ` : "";
    lines.push(truncateToWidth(`${prefix}${descriptionLines[i]}`, width));
  }

  if (!internals.result?.isError) {
    for (const line of firstResultLines(internals, COMPACT_TOOL_LINE_COUNT - lines.length)) {
      lines.push(truncateToWidth(line, width));
    }
  }

  if (internals.result?.isError) {
    const errorLine = firstErrorLine(internals);
    if (errorLine) {
      const lastIndex = lines.length - 1;
      const separator = " — ";
      const withError = `${lines[lastIndex]}${separator}${errorLine}`;
      if (visibleWidth(withError) <= width) {
        lines[lastIndex] = withError;
      } else {
        lines[lastIndex] = truncateToWidth(withError, width);
      }
    }
  }

  return lines;
}
