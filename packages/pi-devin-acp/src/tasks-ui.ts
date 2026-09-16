/**
 * /devin tasks — /ps-style overlay over devin-side operations still in flight
 * (slow execs, detached background shells), mirroring the background
 * terminals dashboard: j/k selection, live 1 Hz refresh, kill action. Killing
 * only works for detached background shells — they run in devin's process, so
 * pi can only ask devin to stop them. Headless modes fall back to
 * ctx.ui.select/confirm prompts.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
  const picked = await ctx.ui.custom<DevinLiveOp | null>(
    (tui, theme, keybindings, done) =>
      new DevinOpsDashboard(tui, theme, keybindings, deps.listOps, selection, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
  if (!picked) return;
  await requestKill(ctx, deps, picked);
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
  private done: (value: DevinLiveOp | null) => void;

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
    done: (value: DevinLiveOp | null) => void,
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

  private close(result: DevinLiveOp | null) {
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
    if (this.keybindings.matches(data, "tui.select.confirm") || data === "x") {
      const op = ops[this.selection.index];
      if (op) this.close(op);
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
          `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")}/x kill · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`,
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
