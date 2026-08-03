import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { firstSanitizedLine, sanitizeCompactText } from "./sanitize-text.ts";

export interface ToolExecutionInternals {
  toolName: string;
  args: unknown;
  callRendererComponent?: Component;
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
  if (!component) return undefined;
  const lines = component.render(width);
  for (const line of lines) {
    const trimmed = trimTrailingPaddingPreservingAnsi(line);
    if (isVisuallyNonEmpty(trimmed)) {
      return trimmed;
    }
  }
  return undefined;
}


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

function statusMarker(internals: ToolExecutionInternals): string {
  if (internals.isPartial) return "…";
  if (internals.result?.isError) return "✗";
  return "✓";
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

export function buildCompactToolLine(internals: ToolExecutionInternals, width: number): string[] {
  if (internals.hideComponent) {
    return [];
  }

  const description =
    firstNonEmptyRenderedLine(internals.callRendererComponent, width) ??
    fallbackToolSummary(internals.toolName, internals.args);

  let line = `${statusMarker(internals)} ${description}`;

  if (internals.result?.isError) {
    const errorLine = firstErrorLine(internals);
    if (errorLine) {
      const separator = " — ";
      const withError = `${line}${separator}${errorLine}`;
      if (visibleWidth(withError) <= width) {
        line = withError;
      } else {
        line = truncateToWidth(withError, width);
      }
    }
  }

  return [truncateToWidth(line, width)];
}
