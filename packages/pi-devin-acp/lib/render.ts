/**
 * Renderers for the display-only `devin` wrapper tool card.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { RecordedDevinTool } from "./replay.ts";
import type { DevinToolView } from "./tool-content.ts";

const MAX_FIELD = 160;

function oneLine(value: string, maxLength = MAX_FIELD): string {
  return stripTerminalSequences(value)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** First card line for a tool_call as it starts streaming. */
export function formatDevinCall(
  view: Pick<DevinToolView, "title" | "kind"> & { summary?: string },
  theme: Theme,
): string {
  const title = oneLine(view.title || view.kind || "tool call");
  const summary = view.summary ? oneLine(view.summary, 100) : "";
  return (
    theme.fg("accent", "devin ") +
    theme.fg("toolTitle", title) +
    (summary ? theme.fg("dim", ` ${summary}`) : "")
  );
}

/** Result line(s) for a completed tool card. */
export function summarizeDevinResult(recorded: RecordedDevinTool): {
  headline: string;
  body?: string;
} {
  if (recorded.error) {
    return { headline: recorded.error };
  }
  if (recorded.diff?.length) {
    const lines = recorded.diff.map((part) => {
      const added = part.newText?.split("\n").length ?? 0;
      const removed = part.oldText?.split("\n").length ?? 0;
      return `${part.path} (+${added}/-${removed})`;
    });
    const body = recorded.output;
    return { headline: lines.join(", "), body };
  }
  return { headline: recorded.title, body: recorded.output };
}
