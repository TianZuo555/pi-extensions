/**
 * /ps UI — two-stage full-screen overlay over the synchronous
 * TerminalReadModel:
 * - TerminalDashboard: list of all tracked terminals (select, kill, open).
 * - TerminalDetailView: read-only inspector for one terminal — default
 *   invocation-info tab, stdout/stderr tabs, scrolling, and live tail. Once a stream outgrows its
 *   in-memory retention the view switches to the complete on-disk spill log and
 *   pages through it (see ./spill-source.ts). No input surface: background
 *   terminals have no stdin by design.
 */

import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatElapsed, formatExit, type TerminalSnapshot } from "../domain.ts";
import type { TerminalReadModel } from "../manager.ts";
import { createOutputLineCache, sanitizeText } from "./output-view.ts";
import { createSpillSource, type SpillSource } from "./spill-source.ts";

/** One-line-safe rendering of model-provided text (titles, commands): a
 * newline or control char inside a fixed-height row desyncs the renderer. */
function oneLine(text: string) {
  return sanitizeText(text.replace(/\s+/g, " "));
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusGlyph(snap: TerminalSnapshot, theme: Theme) {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "■");
    case "done":
      return theme.fg("success", "■");
    case "failed":
    case "timed_out":
      return theme.fg("error", "■");
    case "killed":
      return theme.fg("muted", "■");
  }
}

function statusWord(snap: TerminalSnapshot, theme: Theme) {
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "running");
    case "done":
      return theme.fg("success", "done");
    case "failed":
      return theme.fg("error", "failed");
    case "timed_out":
      return theme.fg("error", "timed out");
    case "killed":
      return theme.fg("muted", "killed");
  }
}

export type TerminalDetailTab = "info" | "stdout" | "stderr";
export const DEFAULT_TERMINAL_DETAIL_TAB: TerminalDetailTab = "info";
const TERMINAL_DETAIL_TABS: readonly TerminalDetailTab[] = ["info", "stdout", "stderr"];

export function cycleTerminalDetailTab(
  current: TerminalDetailTab,
  direction: 1 | -1 = 1,
): TerminalDetailTab {
  const index = TERMINAL_DETAIL_TABS.indexOf(current);
  return (
    TERMINAL_DETAIL_TABS[
      (index + direction + TERMINAL_DETAIL_TABS.length) % TERMINAL_DETAIL_TABS.length
    ] ?? DEFAULT_TERMINAL_DETAIL_TAB
  );
}

/** Output-free invocation metadata used by the default detail tab. */
export function buildTerminalInvocationInfo(snap: TerminalSnapshot): string {
  const lines = [
    `id: ${snap.id}`,
    `title: ${oneLine(snap.title)}`,
    `status: ${snap.status}`,
    `pid: ${snap.pid ?? "?"}`,
    `working directory: ${snap.cwd}`,
    `started: ${new Date(snap.createdAt).toISOString()}`,
    `elapsed: ${formatElapsed(snap)}`,
    `timeout: ${snap.timeoutMs === undefined ? "none" : `${snap.timeoutMs / 1000}s`}`,
    `exit: ${snap.status === "running" ? "-" : formatExit(snap)}`,
    `stdout: ${formatSize(snap.stdout.totalBytes)}${snap.stdout.spillPath ? ` · full log: ${snap.stdout.spillPath}` : ""}`,
    `stderr: ${formatSize(snap.stderr.totalBytes)}${snap.stderr.spillPath ? ` · full log: ${snap.stderr.spillPath}` : ""}`,
  ];
  if (snap.settledAt !== undefined) {
    lines.splice(6, 0, `settled: ${new Date(snap.settledAt).toISOString()}`);
  }
  if (snap.errorText) lines.push(`error: ${oneLine(snap.errorText)}`);
  lines.push("", "command:", snap.command);
  return sanitizeText(lines.join("\n"));
}

// --- Entry point ---------------------------------------------------------------

export async function openTerminalPicker(ctx: ExtensionCommandContext, view: TerminalReadModel) {
  const selection: DashboardSelection = { index: 0 };

  while (true) {
    if (view.size() === 0) {
      ctx.ui.notify("No background terminals", "info");
      return;
    }

    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new TerminalDashboard(tui, theme, keybindings, view, selection, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );

    if (!picked) return;
    if (!view.get(picked)) continue;

    await ctx.ui.custom<null>(
      (tui, theme, keybindings, done) =>
        new TerminalDetailView(tui, theme, keybindings, picked, view, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );
    // After leaving the detail view, fall back to the dashboard.
  }
}

// --- Dashboard (fullscreen overlay) ----------------------------------------------

export interface DashboardSelection {
  id?: string;
  index: number;
}

export function reconcileDashboardSelection(
  selection: DashboardSelection,
  terminals: ReadonlyArray<Pick<TerminalSnapshot, "id">>,
) {
  const stableIndex = selection.id ? terminals.findIndex((snap) => snap.id === selection.id) : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(0, selection.index), Math.max(0, terminals.length - 1));
  selection.id = terminals[selection.index]?.id;
}

class TerminalDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private view: TerminalReadModel;
  private selection: DashboardSelection;
  private done: (value: string | null) => void;

  private closed = false;
  private ticker: ReturnType<typeof setInterval>;
  private unsubChange: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: TerminalReadModel,
    selection: DashboardSelection,
    done: (value: string | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.selection = selection;
    this.done = done;
    // Elapsed times and output sizes tick along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.unsubChange = view.subscribe(() => this.tui.requestRender());
  }

  private terminals(): ReadonlyArray<TerminalSnapshot> {
    return this.view.list();
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.ticker);
    this.unsubChange();
    return true;
  }

  private close(result: string | null) {
    if (this.cleanup()) this.done(result);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    const terminals = this.terminals();
    reconcileDashboardSelection(this.selection, terminals);

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const snap = terminals[this.selection.index];
      if (snap) this.close(snap.id);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (terminals.length > 0) {
        this.selection.index = (this.selection.index - 1 + terminals.length) % terminals.length;
        this.selection.id = terminals[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (terminals.length > 0) {
        this.selection.index = (this.selection.index + 1) % terminals.length;
        this.selection.id = terminals[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (data === "x") {
      const snap = terminals[this.selection.index];
      if (snap && snap.status === "running") this.view.requestKill(snap.id);
      return;
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
    const terminals = this.terminals();
    reconcileDashboardSelection(this.selection, terminals);

    const rows = this.tui.terminal.rows || 30;
    // Render exactly terminal rows - 1 so the overlay covers the header,
    // chat, editor, and extra footer lines while leaving pi's final footer
    // row visible.
    const bodyHeight = Math.max(6, rows - 5);
    const innerWidth = Math.max(0, width - 2);

    const lines: string[] = [];

    // Header: title left, count right
    const headerLeft = theme.fg("accent", theme.bold("Background terminals"));
    const headerRight = theme.fg(
      "muted",
      `${terminals.length} terminal${terminals.length === 1 ? "" : "s"}`,
    );
    const headerPad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4);
    lines.push(truncateToWidth(`  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `, width));

    // Top border with panel title
    const running = terminals.filter((s) => s.status === "running").length;
    lines.push(
      truncateToWidth(
        theme.fg("border", "╭") +
          this.borderSegment(innerWidth, `terminals · ${running} running / ${terminals.length}`) +
          theme.fg("border", "╮"),
        width,
      ),
    );

    // Rows
    const divider = theme.fg("border", "│");
    const rowLines = this.renderRows(terminals, innerWidth, bodyHeight);
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(
        truncateToWidth(divider + this.pad(rowLines[i] ?? "", innerWidth) + divider, width),
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
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} inspect · x kill · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`,
        ),
        width,
      ),
    );

    return lines;
  }

  private renderRows(
    terminals: ReadonlyArray<TerminalSnapshot>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];

    // Scroll window around selection
    let start = 0;
    if (terminals.length > height) {
      start = Math.min(
        Math.max(0, this.selection.index - Math.floor(height / 2)),
        terminals.length - height,
      );
    }
    const visible = terminals.slice(start, start + height);

    for (let i = 0; i < visible.length; i++) {
      const snap = visible[i];
      const index = start + i;
      const isSelected = index === this.selection.index;

      // Left: marker, status square, title, dim id
      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const title = isSelected
        ? theme.fg("accent", oneLine(snap.title))
        : theme.fg("text", oneLine(snap.title));
      const left = ` ${marker} ${statusGlyph(snap, theme)} ${title} ${theme.fg("dim", snap.id)}`;

      // Right: pid · elapsed · exit/status
      const dot = theme.fg("dim", " · ");
      const rightParts = [
        theme.fg("muted", `pid ${snap.pid ?? "?"}`),
        theme.fg("muted", formatElapsed(snap)),
        snap.status === "running" ? statusWord(snap, theme) : theme.fg("muted", formatExit(snap)),
      ];
      const right = `${rightParts.join(dot)} `;

      const rightWidth = visibleWidth(right);
      const leftMax = Math.max(0, width - rightWidth - 2);
      const leftTruncated = truncateToWidth(left, leftMax);
      const gap = Math.max(2, width - visibleWidth(leftTruncated) - rightWidth);
      out.push(truncateToWidth(leftTruncated + " ".repeat(gap) + right, width));
    }

    if (start > 0) {
      out[0] = truncateToWidth(theme.fg("dim", `   ... ${start} more`), width);
    }
    if (start + height < terminals.length) {
      out[out.length - 1] = truncateToWidth(
        theme.fg("dim", `   ... ${terminals.length - start - height} more`),
        width,
      );
    }
    return out;
  }

  invalidate(): void {}
}

// --- Detail view (read-only inspector) --------------------------------------------

const OUTPUT_SCROLL_STEP = 6;

class TerminalDetailView implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private id: string;
  private view: TerminalReadModel;
  private done: (value: null) => void;

  /** Active detail tab; invocation info is deliberately first/default. */
  private tab: TerminalDetailTab = DEFAULT_TERMINAL_DETAIL_TAB;
  /** Scroll offset in lines from the bottom. Info opens at its top; output
   * streams open at 0, pinned to their live tail. */
  private scrollOffset = Number.MAX_SAFE_INTEGER;
  private lineCache = createOutputLineCache();
  /** Complete on-disk logs, opened lazily per stream once retention drops bytes. */
  private sources = new Map<"stdout" | "stderr", SpillSource>();
  /** False once the reader pages away from EOF: the spill window must not be
   * yanked forward under someone reading history. `G` restores it. */
  private following = true;
  /** Whether the last render had the viewport clamped to the top of the window. */
  private atWindowTop = false;
  private unsubscribe: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private ticker: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    id: string,
    view: TerminalReadModel,
    done: (value: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.id = id;
    this.view = view;
    this.done = done;
    this.unsubscribe = view.subscribeTo(id, () => this.scheduleRender());
    // Elapsed time in the header ticks along at 1Hz; the spill window follows
    // EOF on the same tick rather than per output chunk, so a firehose cannot
    // turn every write into a stat + read.
    this.ticker = setInterval(() => {
      this.pumpSpill();
      this.tui.requestRender();
    }, 1000);
    this.pumpSpill();
  }

  private snap(): TerminalSnapshot | undefined {
    return this.view.get(this.id);
  }

  private activeStream(): "stdout" | "stderr" | undefined {
    return this.tab === "info" ? undefined : this.tab;
  }

  /**
   * Disk-backed reader for the active stream, created only once retention has
   * actually dropped bytes — while the in-memory view is still complete it is
   * the same content for free. The Info tab never opens a spill reader.
   */
  private activeSource(snap: TerminalSnapshot): SpillSource | undefined {
    const stream = this.activeStream();
    if (!stream) return undefined;
    const view = stream === "stdout" ? snap.stdout : snap.stderr;
    if (!view.spillPath || view.truncatedBytes === 0) return undefined;
    const existing = this.sources.get(stream);
    if (existing?.path === view.spillPath) return existing;
    existing?.dispose();
    const source = createSpillSource(view.spillPath, () => this.scheduleRender());
    this.sources.set(stream, source);
    return source;
  }

  private currentSource(): SpillSource | undefined {
    const snap = this.snap();
    return snap ? this.activeSource(snap) : undefined;
  }

  /** Load the initial window, and keep it at EOF while still following. */
  private pumpSpill() {
    const source = this.currentSource();
    if (!source) return;
    const state = source.state();
    const unloaded = state.end === 0 && state.error === undefined;
    if (!this.following && !unloaded) return;
    void source.follow();
  }

  /** Extend the window backwards. `force` covers an explicit jump-to-top. */
  private loadEarlier(force: boolean) {
    const source = this.currentSource();
    if (!source) return;
    if (!force && !this.atWindowTop) return;
    if (source.state().start === 0) return;
    this.following = false;
    void source.loadEarlier().then((outcome) => {
      if (this.closed) return;
      // A re-anchored window ends exactly where the previous one began, so
      // pinning to the bottom continues the upward read without a gap.
      if (outcome === "reanchored") this.scrollOffset = 0;
      this.tui.requestRender();
    });
  }

  /** Reached the bottom of the viewport: follow EOF, or page one window on. */
  private reachedBottom(wasAtBottom: boolean) {
    const source = this.currentSource();
    if (!source) return;
    const state = source.state();
    if (state.end >= state.size) {
      this.following = true;
      this.pumpSpill();
      return;
    }
    if (!wasAtBottom) return;
    void source.seekAfter().then((moved) => {
      if (this.closed || !moved) return;
      // The new window starts exactly where the previous one ended: pin to the
      // top (clamped in render) so downward reading continues without a gap.
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.tui.requestRender();
    });
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    // A chatty process emits a chunk per write. Limit terminal repaints so
    // this view cannot starve input handling.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    for (const source of this.sources.values()) source.dispose();
    this.sources.clear();
    return true;
  }

  private close() {
    if (this.cleanup()) this.done(null);
  }

  private switchTab(tab: TerminalDetailTab) {
    if (tab === this.tab) return;
    this.tab = tab;
    this.lineCache = createOutputLineCache();
    this.scrollOffset = tab === "info" ? Number.MAX_SAFE_INTEGER : 0;
    this.following = true;
    this.atWindowTop = false;
    this.pumpSpill();
    this.tui.requestRender();
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.close();
      return;
    }
    if (data === "t" || data === "l" || this.keybindings.matches(data, "tui.editor.cursorRight")) {
      this.switchTab(cycleTerminalDetailTab(this.tab, 1));
      return;
    }
    if (data === "h" || this.keybindings.matches(data, "tui.editor.cursorLeft")) {
      this.switchTab(cycleTerminalDetailTab(this.tab, -1));
      return;
    }
    if (data === "x") {
      const snap = this.snap();
      if (snap?.status === "running") this.view.requestKill(this.id);
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp") || data === "k") {
      this.scrollOffset += OUTPUT_SCROLL_STEP;
      this.loadEarlier(false);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown") || data === "j") {
      const wasAtBottom = this.scrollOffset === 0;
      this.scrollOffset = Math.max(0, this.scrollOffset - OUTPUT_SCROLL_STEP);
      if (this.scrollOffset === 0) this.reachedBottom(wasAtBottom);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.viewportHeight();
      this.loadEarlier(false);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      const wasAtBottom = this.scrollOffset === 0;
      this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight());
      if (this.scrollOffset === 0) this.reachedBottom(wasAtBottom);
      this.tui.requestRender();
      return;
    }
    if (data === "g") {
      this.scrollOffset = Number.MAX_SAFE_INTEGER; // clamped to top in render
      this.loadEarlier(true);
      this.tui.requestRender();
      return;
    }
    if (data === "G") {
      this.scrollOffset = 0;
      this.following = true;
      this.pumpSpill();
      this.tui.requestRender();
      return;
    }
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal.rows || 30;
    // The complete view renders viewport + 7 chrome rows (borders, header,
    // tab, hints). rows - 8 makes the overlay ~terminal rows - 1.
    return Math.max(6, rows - 8);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
    const lines: string[] = [];
    const snap = this.snap();

    if (!snap) {
      lines.push(border);
      lines.push(truncateToWidth(theme.fg("dim", `${this.id} is no longer tracked`), width));
      lines.push(border);
      return lines;
    }

    lines.push(border);
    const header =
      `${statusGlyph(snap, theme)} ` +
      theme.fg("accent", theme.bold(`${snap.id} · ${oneLine(snap.title)}`)) +
      theme.fg("muted", ` · ${snap.status} · ${formatElapsed(snap)} · pid ${snap.pid ?? "?"}`) +
      (snap.status !== "running" ? theme.fg("muted", ` · ${formatExit(snap)}`) : "");
    lines.push(truncateToWidth(header, width));
    lines.push(border);

    // Invocation info is the first/default tab. stdout and stderr stay
    // separate and switch to the full spill log when in-memory retention drops
    // bytes.
    const active = this.tab;
    const source = this.activeSource(snap);
    const spill = source?.state();
    const useSpill = spill !== undefined && spill.error === undefined && spill.text.length > 0;
    const tab = (name: TerminalDetailTab) => {
      const label = name === "info" ? "Info" : `${name} (${formatSize(snap[name].totalBytes)})`;
      return name === active ? theme.fg("accent", theme.bold(label)) : theme.fg("dim", label);
    };
    lines.push(
      truncateToWidth(
        `  ${tab("info")}${theme.fg("dim", " | ")}${tab("stdout")}${theme.fg("dim", " | ")}${tab("stderr")}${theme.fg("dim", "  — t/←/→ to switch")}` +
          (useSpill
            ? theme.fg("dim", this.following ? "  · full log (live)" : "  · full log")
            : ""),
        width,
      ),
    );

    // Fixed-height viewport shared by invocation metadata and stream output.
    // Notes and scroll status consume rows inside it so the overlay height does
    // not change while streaming or switching tabs.
    const noteRows: string[] = [];
    let output: string[];
    if (active === "info") {
      const info = buildTerminalInvocationInfo(snap);
      const version = [
        "info",
        snap.status,
        snap.settledAt ?? Math.floor(Date.now() / 1000),
        snap.stdout.totalBytes,
        snap.stderr.totalBytes,
        snap.errorText ?? "",
      ].join(":");
      output = this.lineCache.get(info, version, width - 2);
    } else {
      const buffer = snap[active];
      const version =
        // totalBytes is a monotonically increasing proxy for a source version.
        // Namespacing prevents retained/spill windows from sharing stale wraps.
        useSpill ? `spill:${spill.version}` : `mem:${buffer.totalBytes}`;
      output = this.lineCache.get(useSpill ? spill.text : buffer.text, version, width - 2);

      if (snap.errorText) {
        noteRows.push(
          truncateToWidth(theme.fg("error", `error: ${oneLine(snap.errorText)}`), width),
        );
      }
      if (useSpill) {
        const earlier = spill.start;
        const later = Math.max(0, spill.size - spill.end);
        const parts = [
          `full log · showing ${formatSize(spill.end - spill.start)} of ${formatSize(spill.size)}`,
        ];
        if (earlier > 0) parts.push(`${formatSize(earlier)} earlier ↑`);
        if (later > 0) parts.push(`${formatSize(later)} later ↓`);
        parts.push(buffer.spillPath ?? "");
        noteRows.push(truncateToWidth(theme.fg("dim", parts.filter(Boolean).join(" · ")), width));
      } else if (spill?.error !== undefined) {
        noteRows.push(
          truncateToWidth(
            theme.fg(
              "dim",
              `full log unavailable (${oneLine(spill.error)}); showing retained output`,
            ),
            width,
          ),
        );
      } else if (buffer.truncatedBytes > 0) {
        noteRows.push(
          truncateToWidth(
            theme.fg(
              "dim",
              `${formatSize(buffer.truncatedBytes)} omitted from middle — full log: ${buffer.spillPath ?? "(unavailable)"}`,
            ),
            width,
          ),
        );
      }
    }

    const viewport = this.viewportHeight();
    const body: string[] = [...noteRows];
    const scrollRows = this.scrollOffset > 0 ? 1 : 0;
    const capacity = Math.max(1, viewport - body.length - scrollRows);
    const maxOffset = Math.max(0, output.length - capacity);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
    // Read by the next ↑/PgUp so it can extend a spill window backwards instead
    // of dead-ending at the top of what is currently loaded.
    this.atWindowTop = this.scrollOffset >= maxOffset;

    const end = output.length - this.scrollOffset;
    const visible = output.slice(Math.max(0, end - capacity), end);
    if (visible.length === 0) {
      body.push(
        truncateToWidth(
          theme.fg("dim", active === "info" ? "(no invocation metadata)" : `(no ${active} yet)`),
          width,
        ),
      );
    } else {
      for (const line of visible) {
        body.push(truncateToWidth(`  ${line}`, width));
      }
    }

    if (this.scrollOffset > 0) {
      body.push(
        truncateToWidth(theme.fg("dim", `... ${this.scrollOffset} lines below · ↓/pgdn`), width),
      );
    }
    while (body.length < viewport) body.push("");
    lines.push(...body.slice(0, viewport));

    lines.push(border);
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `${configuredKeys(this.keybindings, "tui.select.cancel")} back · t/←/→/h/l tabs · x kill · ${configuredKeys(this.keybindings, "tui.editor.cursorUp")}/${configuredKeys(this.keybindings, "tui.editor.cursorDown")}/jk scroll · ${configuredKeys(this.keybindings, "tui.editor.pageUp")}/${configuredKeys(this.keybindings, "tui.editor.pageDown")} page · g/G top/bottom`,
        ),
        width,
      ),
    );
    lines.push(border);
    return lines;
  }

  invalidate(): void {}
}
