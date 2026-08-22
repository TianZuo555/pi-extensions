/**
 * /agy-tasks UI — full-screen overlay dashboard over the filesystem-scanned
 * agy background tasks, mirroring the /ps dashboard interaction model:
 * arrow/jk selection, `enter` for a scrollable log detail view, `x` to
 * terminate the selected task, `r` to rescan, `esc` to close (or to leave
 * the detail view). Data is a snapshot from lib/tasks.ts (log scan + lsof +
 * orphan heuristics); killing re-scans after a short grace period.
 */

import { promises as fs } from "node:fs";
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { stopAgyTask, type AgyTask } from "../lib/tasks.ts";

export type AgyTaskStatus = "running" | "orphan" | "done";

export function agyTaskStatus(task: AgyTask): AgyTaskStatus {
  if (task.pids.length > 0) return "running";
  if (task.orphans.length > 0) return "orphan";
  return "done";
}

function statusGlyph(status: AgyTaskStatus, theme: Theme) {
  switch (status) {
    case "running":
      return theme.fg("warning", "■");
    case "orphan":
      return theme.fg("error", "■");
    case "done":
      return theme.fg("muted", "■");
  }
}

function statusWord(status: AgyTaskStatus, theme: Theme) {
  switch (status) {
    case "running":
      return theme.fg("warning", "running");
    case "orphan":
      return theme.fg("error", "orphan");
    case "done":
      return theme.fg("muted", "done");
  }
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ");
}

/**
 * Sanitize raw task-log text into width-safe display lines: strip terminal
 * escape sequences and remaining control chars, expand tabs, drop trailing
 * blanks. Always returns at least one line.
 */
export function agyTaskLogLines(content: string): string[] {
  const lines = stripTerminalSequences(content)
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.length > 0 ? lines : ["(no output)"];
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

export interface AgyTasksSelection {
  id?: string;
  index: number;
}

export function reconcileAgyTasksSelection(
  selection: AgyTasksSelection,
  tasks: ReadonlyArray<Pick<AgyTask, "id">>,
) {
  const stableIndex = selection.id
    ? tasks.findIndex((task) => task.id === selection.id)
    : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(0, selection.index), Math.max(0, tasks.length - 1));
  selection.id = tasks[selection.index]?.id;
}

export interface AgyTasksModel {
  getTasks(): ReadonlyArray<AgyTask>;
  refresh(): Promise<void>;
  /** Kill the task's processes; resolves after the SIGTERM is sent. */
  kill(task: AgyTask): Promise<number>;
  /** Read the task's log file; resolves to "" when unreadable. */
  readLog(task: AgyTask): Promise<string>;
}

/** Entry point: open the dashboard overlay; resolves when it closes. */
export async function openAgyTasksPicker(
  ctx: ExtensionCommandContext,
  rescan: () => Promise<AgyTask[]>,
): Promise<void> {
  let tasks = await rescan();
  if (tasks.length === 0) {
    ctx.ui.notify("No agy background tasks for this conversation.", "info");
    return;
  }
  const selection: AgyTasksSelection = { index: 0 };
  const model: AgyTasksModel = {
    getTasks: () => tasks,
    refresh: async () => {
      tasks = await rescan();
    },
    kill: (task) => stopAgyTask(task),
    readLog: (task) => fs.readFile(task.logPath, "utf8").catch(() => ""),
  };
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new AgyTasksDashboard(tui, theme, keybindings, model, selection, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}

/** Open log-detail view state: which task, its sanitized log, scroll offset. */
interface AgyTaskDetailView {
  taskId: string;
  lines: string[];
  scroll: number;
}

/** Detail body lines above the log viewport: status, log path, separator. */
const DETAIL_META_LINES = 3;

export class AgyTasksDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private model: AgyTasksModel;
  private selection: AgyTasksSelection;
  private done: (value: null) => void;

  private closed = false;
  private busy = false;
  private detail: AgyTaskDetailView | null = null;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    model: AgyTasksModel,
    selection: AgyTasksSelection,
    done: (value: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.model = model;
    this.selection = selection;
    this.done = done;
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    this.done(null);
  }

  dispose(): void {
    this.closed = true;
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.busy) return;
    const tasks = this.model.getTasks();
    reconcileAgyTasksSelection(this.selection, tasks);

    if (this.detail) {
      this.handleDetailInput(data, tasks);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (tasks.length > 0) {
        this.selection.index =
          (this.selection.index - 1 + tasks.length) % tasks.length;
        this.selection.id = tasks[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (tasks.length > 0) {
        this.selection.index = (this.selection.index + 1) % tasks.length;
        this.selection.id = tasks[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const task = tasks[this.selection.index];
      if (task) void this.openDetail(task);
      return;
    }
    if (data === "r") {
      void this.rescan();
      return;
    }
    if (data === "x") {
      const task = tasks[this.selection.index];
      if (task && agyTaskStatus(task) !== "done") void this.kill(task);
      return;
    }
  }

  private detailViewportHeight(): number {
    const rows = this.tui.terminal.rows || 30;
    return Math.max(1, Math.max(6, rows - 5) - DETAIL_META_LINES);
  }

  private handleDetailInput(data: string, tasks: ReadonlyArray<AgyTask>): void {
    const detail = this.detail;
    if (!detail) return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.detail = null;
      this.tui.requestRender();
      return;
    }
    const viewport = this.detailViewportHeight();
    const maxScroll = Math.max(0, detail.lines.length - viewport);
    const scrollTo = (value: number) => {
      detail.scroll = Math.min(Math.max(0, value), maxScroll);
      this.tui.requestRender();
    };
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      scrollTo(detail.scroll - 1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      scrollTo(detail.scroll + 1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      scrollTo(detail.scroll - viewport);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      scrollTo(detail.scroll + viewport);
      return;
    }
    if (data === "g") {
      scrollTo(0);
      return;
    }
    if (data === "G") {
      scrollTo(Number.MAX_SAFE_INTEGER);
      return;
    }
    if (data === "r") {
      void this.reloadDetail();
      return;
    }
    if (data === "x") {
      const task = tasks.find((entry) => entry.id === detail.taskId);
      if (task && agyTaskStatus(task) !== "done") void this.kill(task);
      return;
    }
  }

  private async openDetail(task: AgyTask): Promise<void> {
    this.busy = true;
    this.tui.requestRender();
    try {
      const content = await this.model.readLog(task);
      this.detail = { taskId: task.id, lines: agyTaskLogLines(content), scroll: 0 };
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  private async reloadDetail(): Promise<void> {
    const detail = this.detail;
    if (!detail) return;
    this.busy = true;
    try {
      await this.model.refresh();
      const task = this.model.getTasks().find((entry) => entry.id === detail.taskId);
      if (task) detail.lines = agyTaskLogLines(await this.model.readLog(task));
      else this.detail = null; // Task vanished — fall back to the list.
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  private async rescan(): Promise<void> {
    this.busy = true;
    try {
      await this.model.refresh();
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  private async kill(task: AgyTask): Promise<void> {
    this.busy = true;
    this.tui.requestRender();
    try {
      await this.model.kill(task);
      // Give the SIGTERM a moment to take effect before rescanning.
      await new Promise((resolve) => setTimeout(resolve, 800));
      await this.model.refresh();
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  private pad(text: string, width: number): string {
    const truncated = truncateToWidth(text, width);
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  }

  private borderSegment(width: number, title: string): string {
    const theme = this.theme;
    const label = title ? ` ${truncateToWidth(title, Math.max(0, width - 3))} ` : "";
    const labelWidth = visibleWidth(label);
    return (
      theme.fg("border", "─") +
      (label ? theme.fg("text", label) : "") +
      theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
    );
  }

  render(width: number): string[] {
    const theme = this.theme;
    const tasks = this.model.getTasks();
    reconcileAgyTasksSelection(this.selection, tasks);

    // Detail mode only while the task is still listed.
    const detailTask = this.detail
      ? tasks.find((task) => task.id === this.detail?.taskId)
      : undefined;
    if (this.detail && !detailTask) this.detail = null;

    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(6, rows - 5);
    const innerWidth = Math.max(0, width - 2);

    const lines: string[] = [];

    // Header: title left, count right
    const headerLeft = theme.fg("accent", theme.bold("agy background tasks"));
    const live = tasks.filter((task) => agyTaskStatus(task) !== "done").length;
    const headerRight = theme.fg(
      "muted",
      `${live} live / ${tasks.length}`,
    );
    const headerPad = Math.max(
      1,
      width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4,
    );
    lines.push(
      truncateToWidth(
        `  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `,
        width,
      ),
    );

    // Top border with panel title
    lines.push(
      truncateToWidth(
        theme.fg("border", "╭") +
          this.borderSegment(
            innerWidth,
            this.busy
              ? "working…"
              : detailTask
                ? `${detailTask.id} · ${agyTaskStatus(detailTask)}`
                : "tasks",
          ) +
          theme.fg("border", "╮"),
        width,
      ),
    );

    // Rows
    const divider = theme.fg("border", "│");
    const rowLines =
      this.detail && detailTask
        ? this.renderDetail(detailTask, this.detail, innerWidth, bodyHeight)
        : this.renderRows(tasks, innerWidth, bodyHeight);
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(
        truncateToWidth(
          divider + this.pad(rowLines[i] ?? "", innerWidth) + divider,
          width,
        ),
      );
    }

    // Bottom border
    lines.push(
      truncateToWidth(
        theme.fg("border", "╰") +
          theme.fg("border", "─".repeat(Math.max(0, innerWidth))) +
          theme.fg("border", "╯"),
        width,
      ),
    );

    // Hints
    const up = configuredKeys(this.keybindings, "tui.select.up");
    const down = configuredKeys(this.keybindings, "tui.select.down");
    const cancel = configuredKeys(this.keybindings, "tui.select.cancel");
    const hints = this.detail
      ? `  ${up}/${down}/jk scroll · g/G top/end · x stop · r reload · ${cancel} back`
      : `  ${up}/${down}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} info · x stop · r rescan · ${cancel} close`;
    lines.push(truncateToWidth(theme.fg("dim", hints), width));

    return lines;
  }

  private renderDetail(
    task: AgyTask,
    detail: AgyTaskDetailView,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const status = agyTaskStatus(task);
    const pids = task.pids.length > 0 ? task.pids : task.orphans;
    const dot = theme.fg("dim", " · ");

    const viewport = Math.max(1, height - DETAIL_META_LINES);
    const maxScroll = Math.max(0, detail.lines.length - viewport);
    detail.scroll = Math.min(Math.max(0, detail.scroll), maxScroll);
    const end = Math.min(detail.scroll + viewport, detail.lines.length);
    const visible = detail.lines.slice(detail.scroll, end);

    const position =
      detail.lines.length > viewport
        ? theme.fg("text", ` ${detail.scroll + 1}–${end}/${detail.lines.length} `)
        : "";
    const separator =
      theme.fg("border", "─") +
      position +
      theme.fg("border", "─".repeat(Math.max(0, width - 1 - visibleWidth(position))));

    const out = [
      ` ${statusWord(status, theme)}${dot}${theme.fg("muted", pids.length > 0 ? `pid ${pids.join(",")}` : "pid -")}${dot}${theme.fg("muted", `${task.bytes}B`)}`,
      ` ${theme.fg("dim", task.logPath)}`,
      separator,
    ];
    for (const line of visible) out.push(` ${line}`);
    return out;
  }

  private renderRows(
    tasks: ReadonlyArray<AgyTask>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];

    // Scroll window around selection
    let start = 0;
    if (tasks.length > height) {
      start = Math.min(
        Math.max(0, this.selection.index - Math.floor(height / 2)),
        tasks.length - height,
      );
    }
    const visible = tasks.slice(start, start + height);

    for (let i = 0; i < visible.length; i++) {
      const task = visible[i];
      const index = start + i;
      const isSelected = index === this.selection.index;
      const status = agyTaskStatus(task);

      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const title = isSelected
        ? theme.fg("accent", oneLine(task.description))
        : theme.fg("text", oneLine(task.description));
      const pids =
        task.pids.length > 0
          ? task.pids
          : task.orphans;
      const left = ` ${marker} ${statusGlyph(status, theme)} ${title} ${theme.fg("dim", task.id)}`;

      const dot = theme.fg("dim", " · ");
      const rightParts = [
        theme.fg("muted", pids.length > 0 ? `pid ${pids.join(",")}` : "pid -"),
        theme.fg("muted", `${task.bytes}B`),
        statusWord(status, theme),
      ];
      const right = `${rightParts.join(dot)} `;

      const rightWidth = visibleWidth(right);
      const leftMax = Math.max(0, width - rightWidth - 2);
      out.push(
        truncateToWidth(left, leftMax) +
          " ".repeat(Math.max(1, width - visibleWidth(truncateToWidth(left, leftMax)) - rightWidth)) +
          right,
      );
    }
    return out;
  }
}
