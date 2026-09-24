/**
 * Devin's `todo_write` task list (sent as ACP `plan` updates) rendered as
 * a checklist widget above pi's editor, in the same shape as pi-todo's
 * list: header with progress, one line per entry.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeDevinText } from "../lib/render.ts";
import type { DevinPlanEntry } from "./turn.ts";

const STATUS_ICON: Record<string, string> = { completed: "✓", in_progress: "◉" };

export function renderDevinPlanLines(
  entries: DevinPlanEntry[],
  theme: Theme,
  width: number,
): string[] {
  const completed = entries.filter((entry) => entry.status === "completed").length;
  const lines = [
    theme.fg("accent", " todo_write ") + theme.fg("muted", `${completed}/${entries.length}`),
    ...entries.map((entry) => {
      const content = sanitizeDevinText(entry.content).replace(/\s+/g, " ").trim();
      const label =
        entry.status === "completed"
          ? theme.fg("dim", content)
          : entry.status === "in_progress"
            ? theme.fg("warning", content)
            : content;
      return `  ${STATUS_ICON[entry.status ?? ""] ?? "○"} ${label}`;
    }),
  ];
  return lines.map((line) => truncateToWidth(line, width));
}

/** Widget factory for `ctx.ui.setWidget`. */
export function devinPlanWidget(entries: DevinPlanEntry[]) {
  return (_tui: TUI, theme: Theme): Component => ({
    render: (width: number) => renderDevinPlanLines(entries, theme, width),
    invalidate: () => {},
  });
}

/** Only the newest asynchronous snapshot may update the plan widget. */
export function createLatestPlanRefresh(
  read: () => Promise<DevinPlanEntry[] | undefined>,
  publish: (entries: DevinPlanEntry[]) => void,
) {
  let revision = 0;
  return {
    refresh: async () => {
      const current = ++revision;
      const entries = await read().catch(() => undefined);
      if (current === revision) publish(entries ?? []);
    },
    invalidate: () => {
      revision++;
    },
  };
}
