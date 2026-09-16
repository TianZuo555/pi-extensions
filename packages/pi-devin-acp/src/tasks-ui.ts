/**
 * /devin-tasks — /ps-style two-stage overlay over devin-side operations
 * still in flight (slow execs, detached background shells), mirroring the
 * background terminals dashboard: enter opens a read-only detail view
 * (invocation info + live streamed output, /ps-style tabs and scrolling),
 * x requests a stop. Killing only works for detached background shells —
 * they run in devin's process, so pi can only ask devin to stop them; the
 * confirm dialog runs after the overlay closes because pi's dialogs cannot
 * stack on a custom overlay. Headless modes fall back to ctx.ui.select/
 * confirm prompts.
 */

import { formatSize } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { devinKillShellPrompt } from "../lib/prompt.ts";
import { sanitizeDevinText } from "../lib/render.ts";
import type { DevinLiveOp } from "./runtime.ts";

function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

export function describeLiveOp(op: DevinLiveOp, now = Date.now()): string {
  const view = op.view;
  const bits: string[] = [];
  if (view.kind) bits.push(view.kind);
  if (view.tool) bits.push(view.tool);
  bits.push(formatElapsed(op.startedAt, now));
  if (view.shellId) bits.push(`bg shell ${view.shellId}`);
  const title = sanitizeDevinText(view.title?.trim() || "(untitled op)");
  const line = `${title} — ${bits.join(" · ")}`;
  return line.length > 90 ? `${line.slice(0, 87)}…` : line;
}

export interface DevinTasksUiDeps {
  listOps: () => Promise<DevinLiveOp[]> | DevinLiveOp[];
  /** Send a plain-text instruction into the live devin session. */
  sendToSession: ExtensionAPI["sendUserMessage"];
}

function oneLine(text: string, max = 120): string {
  return sanitizeDevinText(text.replace(/\s+/g, " ")).trim().slice(0, max);
}

/** ACP toolCallIds ("call_…") are long; show a short discriminator. */
function compactId(id: string): string {
  const trimmed = id.replace(/^call_/, "");
  return trimmed.length > 10 ? `${trimmed.slice(0, 9)}…` : trimmed;
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

/** Ask devin to stop a background shell, after confirmation. */
async function requestKill(
  ctx: ExtensionContext,
  deps: DevinTasksUiDeps,
  op: DevinLiveOp,
): Promise<void> {
  if (!op.view.shellId) {
    ctx.ui.notify(
      `devin: "${oneLine(op.view.title ?? op.view.id, 60)}" runs inside devin's turn — only devin can stop it.`,
      "info",
    );
    return;
  }
  const kill = await ctx.ui.confirm(
    "devin tasks",
    `Ask devin to kill background shell ${op.view.shellId}? It runs in devin's process, so only devin can stop it.`,
  );
  if (!kill) return;
  try {
    await deps.sendToSession(devinKillShellPrompt(op.view.shellId), {
      deliverAs: "steer",
      expandPromptTemplates: false,
    });
    ctx.ui.notify(`devin: queued request to kill shell ${op.view.shellId}.`, "info");
  } catch (error) {
    ctx.ui.notify(
      `devin: could not request shell stop (${error instanceof Error ? error.message : error}).`,
      "error",
    );
  }
}

/** What the overlay flow decided to do with one op. */
export interface DevinTasksAction {
  kind: "inspect" | "kill";
  op: DevinLiveOp;
}

/** Run the /devin tasks flow. */
export async function runDevinTasksPicker(
  ctx: ExtensionContext,
  deps: DevinTasksUiDeps,
): Promise<void> {
  const ops = await deps.listOps();
  if (ops.length === 0) {
    ctx.ui.notify("devin: no running operations.", "info");
    return;
  }
  if (ctx.mode !== "tui") {
    const labels = ops.map((op) => describeLiveOp(op));
    const picked = await ctx.ui.select("devin tasks", labels);
    if (!picked) return;
    const op = ops[labels.indexOf(picked)];
    if (op) await requestKill(ctx, deps, op);
    return;
  }
  const selection: OpsSelection = { index: 0 };
  while (true) {
    const picked = await ctx.ui.custom<DevinTasksAction | null>(
      (tui, theme, keybindings, done) =>
        new DevinOpsDashboard(tui, theme, keybindings, deps.listOps, selection, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );
    if (!picked || picked.kind === "kill") {
      if (picked) await requestKill(ctx, deps, picked.op);
      return;
    }
    // Inspect: after leaving the detail view, fall back to the dashboard.
    const action = await ctx.ui.custom<DevinTasksAction | null>(
      (tui, theme, keybindings, done) =>
        new DevinOpDetail(
          tui,
          theme,
          keybindings,
          picked.op.view.id,
          deps.listOps,
          picked.op,
          done,
        ),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );
    if (action?.kind === "kill") {
      await requestKill(ctx, deps, action.op);
      return;
    }
  }
}

// --- Dashboard (fullscreen overlay) ----------------------------------------------

export interface OpsSelection {
  id?: string;
  index: number;
}

/** Keep the selection anchored to one op across refreshes. */
export function reconcileOpsSelection(selection: OpsSelection, ids: readonly string[]): void {
  const stableIndex = selection.id ? ids.indexOf(selection.id) : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(0, selection.index), Math.max(0, ids.length - 1));
  selection.id = ids[selection.index];
}

class DevinOpsDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private listOps: () => Promise<DevinLiveOp[]> | DevinLiveOp[];
  private selection: OpsSelection;
  private done: (value: DevinTasksAction | null) => void;

  private ops: DevinLiveOp[] = [];
  private closed = false;
  private refreshing = false;
  private ticker: ReturnType<typeof setInterval>;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    listOps: () => Promise<DevinLiveOp[]> | DevinLiveOp[],
    selection: OpsSelection,
    done: (value: DevinTasksAction | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.listOps = listOps;
    this.selection = selection;
    this.done = done;
    // Elapsed times tick at 1 Hz; the op list refreshes on the same beat.
    this.ticker = setInterval(() => {
      void this.refresh();
      this.tui.requestRender();
    }, 1000);
    void this.refresh();
  }

  /** Pull the live-op snapshot; empty or failing refreshes keep the view. */
  private async refresh(): Promise<void> {
    if (this.closed || this.refreshing) return;
    this.refreshing = true;
    try {
      const next = await this.listOps();
      if (this.closed) return;
      if (next.length === 0) {
        // Everything settled while the dashboard was open.
        this.close(null);
        return;
      }
      this.ops = next;
      reconcileOpsSelection(
        this.selection,
        this.ops.map((op) => op.view.id),
      );
    } catch {
      // Snapshot failure keeps the last view; the next tick retries.
    } finally {
      this.refreshing = false;
    }
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.ticker);
    return true;
  }

  private close(result: DevinTasksAction | null) {
    if (this.cleanup()) this.done(result);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    const ops = this.ops;
    reconcileOpsSelection(
      this.selection,
      ops.map((op) => op.view.id),
    );

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const op = ops[this.selection.index];
      if (op) this.close({ kind: "inspect", op });
      return;
    }
    if (data === "x") {
      const op = ops[this.selection.index];
      if (op) this.close({ kind: "kill", op });
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (ops.length > 0) {
        this.selection.index = (this.selection.index - 1 + ops.length) % ops.length;
        this.selection.id = ops[this.selection.index]?.view.id;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (ops.length > 0) {
        this.selection.index = (this.selection.index + 1) % ops.length;
        this.selection.id = ops[this.selection.index]?.view.id;
        this.tui.requestRender();
      }
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
    const ops = this.ops;
    reconcileOpsSelection(
      this.selection,
      ops.map((op) => op.view.id),
    );

    const rows = this.tui.terminal.rows || 30;
    // Render exactly terminal rows - 1 so the overlay covers the header,
    // chat, editor, and extra footer lines while leaving pi's final footer
    // row visible.
    const bodyHeight = Math.max(6, rows - 5);
    const innerWidth = Math.max(0, width - 2);

    const lines: string[] = [];

    // Header: title left, count right
    const headerLeft = theme.fg("accent", theme.bold("Devin operations"));
    const headerRight = theme.fg("muted", `${ops.length} op${ops.length === 1 ? "" : "s"}`);
    const headerPad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4);
    lines.push(truncateToWidth(`  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `, width));

    // Top border with panel title
    lines.push(
      truncateToWidth(
        theme.fg("border", "╭") +
          this.borderSegment(innerWidth, `devin ops · ${ops.length} running`) +
          theme.fg("border", "╮"),
        width,
      ),
    );

    // Rows
    const divider = theme.fg("border", "│");
    const rowLines = this.renderRows(ops, innerWidth, bodyHeight);
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

  private renderRows(ops: ReadonlyArray<DevinLiveOp>, width: number, height: number): string[] {
    const theme = this.theme;
    const out: string[] = [];

    // Scroll window around selection
    let start = 0;
    if (ops.length > height) {
      start = Math.min(
        Math.max(0, this.selection.index - Math.floor(height / 2)),
        ops.length - height,
      );
    }
    const visible = ops.slice(start, start + height);
    const now = Date.now();

    for (let i = 0; i < visible.length; i++) {
      const op = visible[i];
      const index = start + i;
      const isSelected = index === this.selection.index;
      const view = op.view;

      // Left: marker, running square, title, dim id
      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const glyph = theme.fg(view.background || view.shellId ? "accent" : "warning", "■");
      const title = isSelected
        ? theme.fg("accent", oneLine(view.title || "(untitled op)"))
        : theme.fg("text", oneLine(view.title || "(untitled op)"));
      const left = ` ${marker} ${glyph} ${title} ${theme.fg("dim", compactId(view.id))}`;

      // Right: kind · elapsed · shell/turn
      const dot = theme.fg("dim", " · ");
      const rightParts = [
        theme.fg("muted", view.kind ?? view.tool ?? "op"),
        theme.fg("muted", formatElapsed(op.startedAt, now)),
        view.shellId ? theme.fg("muted", `bg shell ${view.shellId}`) : theme.fg("muted", "in-turn"),
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
    if (start + height < ops.length) {
      out[out.length - 1] = truncateToWidth(
        theme.fg("dim", `   ... ${ops.length - start - height} more`),
        width,
      );
    }
    return out;
  }

  invalidate(): void {}
}

// --- Detail view (read-only inspector) --------------------------------------------

const OP_SCROLL_STEP = 6;

export type DevinDetailTab = "info" | "output";
export const DEFAULT_DEVIN_DETAIL_TAB: DevinDetailTab = "info";
const DEVIN_DETAIL_TABS: readonly DevinDetailTab[] = ["info", "output"];

export function cycleDevinDetailTab(
  current: DevinDetailTab,
  direction: 1 | -1 = 1,
): DevinDetailTab {
  const index = DEVIN_DETAIL_TABS.indexOf(current);
  return (
    DEVIN_DETAIL_TABS[(index + direction + DEVIN_DETAIL_TABS.length) % DEVIN_DETAIL_TABS.length] ??
    DEFAULT_DEVIN_DETAIL_TAB
  );
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Invocation metadata for the detail view's default tab. */
export function buildDevinOpInfo(op: DevinLiveOp, now = Date.now()): string {
  const view = op.view;
  const lines = [
    `id: ${view.id}`,
    `title: ${view.title ? oneLine(view.title, 200) : "(untitled op)"}`,
    `kind: ${view.kind ?? "?"}`,
    `tool: ${view.tool ?? "?"}`,
    `status: ${view.status ?? "running"}`,
    `started: ${new Date(op.startedAt).toISOString()}`,
    `elapsed: ${formatElapsed(op.startedAt, now)}`,
    `scope: ${view.shellId ? `background shell ${view.shellId}` : "in-turn (devin's process)"}`,
  ];
  if (view.exitCode !== undefined) lines.push(`exit code: ${view.exitCode}`);
  if (view.locations?.length) lines.push(`locations: ${view.locations.join(", ")}`);
  if (view.rawInput !== undefined) lines.push("", "input:", prettyJson(view.rawInput));
  return sanitizeDevinText(lines.join("\n"));
}

/** Split, sanitize, and wrap streamed devin output into display lines.
 * Progress lines rewritten via carriage returns keep only their final state. */
export function buildDevinOpOutputLines(text: string, width: number): string[] {
  const safeWidth = Math.max(10, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const segments = raw.split("\r");
    const finalSegment = segments.at(-1) ?? "";
    const lastSegment = finalSegment || [...segments].reverse().find((s) => s) || "";
    const clean = sanitizeDevinText(lastSegment).replaceAll("\t", "  ");
    if (clean.length === 0) {
      out.push("");
      continue;
    }
    out.push(...wrapTextWithAnsi(clean, safeWidth));
  }
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** Wrapped-line cache keyed by (source version, width) so 1 Hz refreshes and
 * scrolling never re-wrap long streams; mirrors /ps's output view cache. */
export function createOpLineCache() {
  let key: string | undefined;
  let lines: string[] = [];
  return {
    get(text: string, version: string | number, width: number) {
      const nextKey = `${version}:${width}`;
      if (key !== nextKey) {
        key = nextKey;
        lines = buildDevinOpOutputLines(text, width);
      }
      return lines;
    },
  };
}

class DevinOpDetail implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private opId: string;
  private listOps: () => Promise<DevinLiveOp[]> | DevinLiveOp[];
  private done: (value: DevinTasksAction | null) => void;

  /** Latest live-op snapshot, seeded with the picked op. */
  private op: DevinLiveOp;
  /** Set when the op left liveOps (settled): the last view freezes. */
  private settledAt: number | undefined;
  /** Active tab; invocation info is deliberately first/default. */
  private tab: DevinDetailTab = DEFAULT_DEVIN_DETAIL_TAB;
  /** Scroll offset in lines from the bottom. Info opens at its top; output
   * opens at 0, pinned to the live tail. */
  private scrollOffset = Number.MAX_SAFE_INTEGER;
  private lineCache = createOpLineCache();
  private closed = false;
  private refreshing = false;
  private ticker: ReturnType<typeof setInterval>;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    opId: string,
    listOps: () => Promise<DevinLiveOp[]> | DevinLiveOp[],
    seed: DevinLiveOp,
    done: (value: DevinTasksAction | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.opId = opId;
    this.listOps = listOps;
    this.op = seed;
    this.done = done;
    // Elapsed time ticks and the op snapshot refreshes at 1 Hz.
    this.ticker = setInterval(() => {
      void this.refresh();
      this.tui.requestRender();
    }, 1000);
  }

  /** Pull the op snapshot; freeze the view once the op settles. */
  private async refresh(): Promise<void> {
    if (this.closed || this.refreshing || this.settledAt !== undefined) return;
    this.refreshing = true;
    try {
      const next = await this.listOps();
      if (this.closed) return;
      const found = next.find((op) => op.view.id === this.opId);
      if (!found) {
        this.settledAt = Date.now();
        return;
      }
      this.op = found;
    } catch {
      // Snapshot failure keeps the last view; the next tick retries.
    } finally {
      this.refreshing = false;
    }
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.ticker);
    return true;
  }

  private close(result: DevinTasksAction | null) {
    if (this.cleanup()) this.done(result);
  }

  dispose(): void {
    this.cleanup();
  }

  private switchTab(tab: DevinDetailTab) {
    if (tab === this.tab) return;
    this.tab = tab;
    this.scrollOffset = tab === "info" ? Number.MAX_SAFE_INTEGER : 0;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.close(null);
      return;
    }
    if (data === "t" || data === "l" || this.keybindings.matches(data, "tui.editor.cursorRight")) {
      this.switchTab(cycleDevinDetailTab(this.tab, 1));
      return;
    }
    if (data === "h" || this.keybindings.matches(data, "tui.editor.cursorLeft")) {
      this.switchTab(cycleDevinDetailTab(this.tab, -1));
      return;
    }
    if (data === "x") {
      if (this.settledAt === undefined) this.close({ kind: "kill", op: this.op });
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp") || data === "k") {
      this.scrollOffset += OP_SCROLL_STEP;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown") || data === "j") {
      this.scrollOffset = Math.max(0, this.scrollOffset - OP_SCROLL_STEP);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.viewportHeight();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight());
      this.tui.requestRender();
      return;
    }
    if (data === "g") {
      this.scrollOffset = Number.MAX_SAFE_INTEGER; // clamped to top in render
      this.tui.requestRender();
      return;
    }
    if (data === "G") {
      this.scrollOffset = 0;
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
    const view = this.op.view;
    const now = this.settledAt ?? Date.now();

    const glyph = theme.fg(view.background || view.shellId ? "accent" : "warning", "■");
    lines.push(border);
    const header =
      `${glyph} ` +
      theme.fg("accent", theme.bold(`${view.tool ?? view.kind ?? "op"} · ${oneLine(view.title || "(untitled op)", 100)}`)) +
      theme.fg(
        "muted",
        ` · ${view.status ?? "running"} · ${formatElapsed(this.op.startedAt, now)} · ${view.shellId ? `bg shell ${view.shellId}` : "in-turn"}`,
      ) +
      (this.settledAt !== undefined ? theme.fg("muted", " · settled") : "");
    lines.push(truncateToWidth(header, width));
    lines.push(border);

    const active = this.tab;
    const tab = (name: DevinDetailTab) => {
      const label = name === "output" ? `Output (${formatSize(view.output?.length ?? 0)})` : "Info";
      return name === active ? theme.fg("accent", theme.bold(label)) : theme.fg("dim", label);
    };
    lines.push(
      truncateToWidth(
        `  ${tab("info")}${theme.fg("dim", " | ")}${tab("output")}${theme.fg("dim", "  — t/←/→ to switch")}`,
        width,
      ),
    );

    // Fixed-height viewport shared by metadata and streamed output; notes
    // consume rows inside it so the overlay height never changes.
    const noteRows: string[] = [];
    if (this.settledAt !== undefined) {
      noteRows.push(
        truncateToWidth(
          theme.fg("dim", "op settled — devin reported completion; view frozen"),
          width,
        ),
      );
    }

    let output: string[];
    if (active === "info") {
      const info = buildDevinOpInfo(this.op, now);
      // The elapsed line ticks at 1 Hz; the second bucket keys the wrap cache.
      const version = `info:${view.status}:${view.exitCode ?? ""}:${Math.floor(now / 1000)}`;
      output = this.lineCache.get(info, version, width - 2);
    } else {
      const text = view.output ?? "";
      output = this.lineCache.get(text, `out:${view.status}:${text.length}`, width - 2);
    }

    const viewport = this.viewportHeight();
    const body: string[] = [...noteRows];
    const scrollRows = this.scrollOffset > 0 ? 1 : 0;
    const capacity = Math.max(1, viewport - body.length - scrollRows);
    const maxOffset = Math.max(0, output.length - capacity);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    const end = output.length - this.scrollOffset;
    const visible = output.slice(Math.max(0, end - capacity), end);
    if (visible.length === 0) {
      body.push(
        truncateToWidth(
          theme.fg("dim", active === "info" ? "(no metadata)" : "(no streamed output yet)"),
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
