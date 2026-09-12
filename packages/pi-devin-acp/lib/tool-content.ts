/**
 * Normalize ACP `tool_call` / `tool_call_update` payloads into a flat display
 * shape for the replay store and the `devin` wrapper card renderer.
 */

import type { ToolCall, ToolCallContent, ToolCallUpdate } from "@agentclientprotocol/sdk";

export interface DevinToolDiff {
  path: string;
  oldText?: string;
  newText?: string;
}

export interface DevinToolView {
  id: string;
  /** Devin's human-readable title ("Wrote /tmp/x.txt"); absent on updates. */
  title?: string;
  /** ACP kind bucket: read/edit/execute/search/… */
  kind?: string;
  status?: string;
  /** Devin-native tool name from `_meta["cognition.ai/inferenceToolName"]`. */
  tool?: string;
  /** Flattened text content for the card body. */
  output?: string;
  diff?: DevinToolDiff[];
  locations?: string[];
  rawInput?: unknown;
  /** Devin detached the command to a background shell; it may outlive the turn. */
  background?: boolean;
  /** Devin background shell id, when reported. */
  shellId?: string;
  /** The underlying terminal exited (`_meta["cognition.ai/terminal_exit"]`). */
  exitCode?: number;
}

function metaToolName(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)["cognition.ai/inferenceToolName"];
  return typeof value === "string" && value ? value : undefined;
}

function contentToDisplay(content: ToolCallContent[] | null | undefined): {
  output?: string;
  diff?: DevinToolDiff[];
} {
  if (!Array.isArray(content) || content.length === 0) return {};
  const texts: string[] = [];
  const diff: DevinToolDiff[] = [];
  for (const part of content) {
    if (part.type === "content") {
      const inner = part.content;
      if (inner?.type === "text" && typeof inner.text === "string") {
        texts.push(inner.text);
      } else if (inner?.type === "resource" && "text" in inner.resource) {
        texts.push(inner.resource.text);
      }
      continue;
    }
    if (part.type === "diff") {
      diff.push({
        path: part.path,
        oldText: part.oldText ?? undefined,
        newText: part.newText ?? undefined,
      });
    }
    // terminal and unknown content kinds: nothing flat to display.
  }
  return {
    output: texts.length ? texts.join("\n") : undefined,
    diff: diff.length ? diff : undefined,
  };
}

function locationPaths(locations: { path: string }[] | null | undefined): string[] | undefined {
  if (!Array.isArray(locations) || locations.length === 0) return undefined;
  const paths = locations
    .map((location) => location.path)
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  return paths.length ? paths : undefined;
}

/** Merge a tool_call start with its latest update into one view. */
export function mergeDevinTool(
  start: ToolCall | undefined,
  update: ToolCall | ToolCallUpdate | undefined,
): DevinToolView {
  const merged = { ...(start ?? {}), ...(update ?? {}) } as ToolCall & ToolCallUpdate;
  const { output, diff } = contentToDisplay(merged.content);
  // Only include defined fields so view-level spreads (start → update) don't
  // clobber a real value with an absent one.
  const view: DevinToolView = { id: merged.toolCallId };
  const title = merged.title ?? start?.title;
  if (title !== undefined) view.title = title;
  const kind = merged.kind ?? start?.kind ?? undefined;
  if (kind !== undefined) view.kind = kind;
  const status = merged.status ?? start?.status ?? undefined;
  if (status !== undefined) view.status = status;
  const tool = metaToolName(merged._meta) ?? metaToolName(start?._meta);
  if (tool !== undefined) view.tool = tool;
  const meta =
    typeof merged._meta === "object" && merged._meta !== null
      ? (merged._meta as Record<string, unknown>)
      : undefined;
  if (meta?.["cognition.ai/background"] === true) view.background = true;
  const shellId = meta?.["cognition.ai/backgroundShellId"];
  if (typeof shellId === "string" && shellId) view.shellId = shellId;
  else if (typeof shellId === "number") view.shellId = String(shellId);
  const terminalExit = meta?.["cognition.ai/terminal_exit"];
  if (typeof terminalExit === "object" && terminalExit !== null) {
    const code = (terminalExit as Record<string, unknown>).exit_code;
    if (typeof code === "number") view.exitCode = code;
    else view.exitCode = -1;
  }
  if (output !== undefined) view.output = output;
  if (diff !== undefined) view.diff = diff;
  const locations = locationPaths(merged.locations ?? start?.locations);
  if (locations !== undefined) view.locations = locations;
  const rawInput = merged.rawInput ?? start?.rawInput;
  if (rawInput !== undefined) view.rawInput = rawInput;
  return view;
}

/** Small summary of args for the call card's first line. */
export function summarizeDevinCall(view: DevinToolView): string {
  const bits: string[] = [];
  if (view.kind) bits.push(view.kind);
  if (view.locations?.length) bits.push(view.locations.join(", "));
  if (view.rawInput && typeof view.rawInput === "object") {
    const input = view.rawInput as Record<string, unknown>;
    for (const key of [
      "command",
      "cmd",
      "query",
      "pattern",
      "file_path",
      "path",
      "url",
      "shell_id",
    ]) {
      const value = input[key];
      if (typeof value === "string" && value) {
        bits.push(value.length > 80 ? `${value.slice(0, 77)}…` : value);
        break;
      }
    }
  }
  return bits.join(" · ");
}
