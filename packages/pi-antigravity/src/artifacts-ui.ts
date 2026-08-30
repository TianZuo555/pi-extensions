/**
 * /agy-artifacts UI — full-screen overlay listing the current agy
 * conversation's artifacts (agent-created media/files and user uploads),
 * mirroring the /agy-tasks dashboard interaction model: arrow/jk selection,
 * `o` to open the selected artifact with the system default app, `r` to
 * rescan, esc to close.
 */

import { execFile } from "node:child_process";
import { open as openFile } from "node:fs/promises";
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
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgyArtifact } from "../lib/artifacts.ts";

function oneLine(text: string) {
  return text.replace(/\s+/g, " ");
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

export interface AgyArtifactsSelection {
  name?: string;
  index: number;
}

export function reconcileAgyArtifactsSelection(
  selection: AgyArtifactsSelection,
  artifacts: ReadonlyArray<Pick<AgyArtifact, "name">>,
) {
  const stableIndex = selection.name
    ? artifacts.findIndex((artifact) => artifact.name === selection.name)
    : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(0, selection.index), Math.max(0, artifacts.length - 1));
  selection.name = artifacts[selection.index]?.name;
}

export interface AgyArtifactsModel {
  getArtifacts(): ReadonlyArray<AgyArtifact>;
  refresh(): Promise<void>;
}

export const MARKDOWN_PREVIEW_MAX_BYTES = 256 * 1024;

export interface AgyMarkdownPreview {
  text: string;
  truncated: boolean;
  completed: number;
  total: number;
}

export async function readMarkdownPreview(
  absolutePath: string,
  maxBytes = MARKDOWN_PREVIEW_MAX_BYTES,
): Promise<AgyMarkdownPreview> {
  const handle = await openFile(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesReadTotal = 0;
    while (bytesReadTotal < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        bytesReadTotal,
        buffer.length - bytesReadTotal,
        bytesReadTotal,
      );
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
    }
    const truncated = bytesReadTotal > maxBytes;
    const bytes = buffer.subarray(0, Math.min(bytesReadTotal, maxBytes));
    // Streaming decode on a truncated prefix drops only an incomplete final
    // code point; malformed UTF-8 anywhere else still fails closed.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: truncated,
    });
    let completed = 0;
    let total = 0;
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*-\s+\[([ xX])\]\s+/);
      if (!match) continue;
      total += 1;
      if (match[1]?.toLowerCase() === "x") completed += 1;
    }
    return { text, truncated, completed, total };
  } finally {
    await handle.close();
  }
}

/** Open a file with the OS default handler. Resolves after launch. */
export function openArtifact(absolutePath: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve, reject) => {
    execFile(command, [absolutePath], { timeout: 10_000 }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

/** Entry point: open the dashboard overlay; resolves when it closes. */
export async function openAgyArtifactsPicker(
  ctx: ExtensionCommandContext,
  rescan: () => Promise<AgyArtifact[]>,
): Promise<void> {
  let artifacts = await rescan();
  if (artifacts.length === 0) {
    ctx.ui.notify("No artifacts for this agy conversation.", "info");
    return;
  }
  const selection: AgyArtifactsSelection = { index: 0 };
  const model: AgyArtifactsModel = {
    getArtifacts: () => artifacts,
    refresh: async () => {
      artifacts = await rescan();
    },
  };
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new AgyArtifactsDashboard(tui, theme, keybindings, model, selection, done, (message) =>
        ctx.ui.notify(message, "error"),
      ),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}

export class AgyArtifactsDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private model: AgyArtifactsModel;
  private selection: AgyArtifactsSelection;
  private done: (value: null) => void;
  private closed = false;
  private busy = false;
  private preview:
    | { artifact: AgyArtifact; content: AgyMarkdownPreview; scroll: number }
    | undefined;
  private notifyError: (message: string) => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    model: AgyArtifactsModel,
    selection: AgyArtifactsSelection,
    done: (value: null) => void,
    notifyError: (message: string) => void = () => {},
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.model = model;
    this.selection = selection;
    this.done = done;
    this.notifyError = notifyError;
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
    const artifacts = this.model.getArtifacts();
    reconcileAgyArtifactsSelection(this.selection, artifacts);

    if (this.preview) {
      if (this.keybindings.matches(data, "tui.select.cancel")) {
        this.preview = undefined;
        this.tui.requestRender();
        return;
      }
      if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
        this.preview.scroll = Math.max(0, this.preview.scroll - 1);
        this.tui.requestRender();
        return;
      }
      if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
        this.preview.scroll += 1;
        this.tui.requestRender();
        return;
      }
      if (data === "o") void this.open(this.preview.artifact.absolutePath);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (artifacts.length > 0) {
        this.selection.index = (this.selection.index - 1 + artifacts.length) % artifacts.length;
        this.selection.name = artifacts[this.selection.index]?.name;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (artifacts.length > 0) {
        this.selection.index = (this.selection.index + 1) % artifacts.length;
        this.selection.name = artifacts[this.selection.index]?.name;
        this.tui.requestRender();
      }
      return;
    }
    if (data === "r") {
      void this.rescan();
      return;
    }
    if (data === "o") {
      const artifact = artifacts[this.selection.index];
      if (artifact) void this.open(artifact.absolutePath);
      return;
    }
    if (data === "v" || this.keybindings.matches(data, "tui.select.confirm")) {
      const artifact = artifacts[this.selection.index];
      if (artifact?.mediaType === "markdown") void this.loadPreview(artifact);
      return;
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

  private async loadPreview(artifact: AgyArtifact): Promise<void> {
    this.busy = true;
    this.tui.requestRender();
    try {
      const content = await readMarkdownPreview(artifact.absolutePath);
      this.preview = { artifact, content, scroll: 0 };
    } catch (error) {
      this.notifyError(
        `agy-artifacts: cannot preview ${artifact.name} (${error instanceof Error ? error.message : String(error)}).`,
      );
      this.preview = undefined;
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  private async open(absolutePath: string): Promise<void> {
    this.busy = true;
    this.tui.requestRender();
    try {
      await openArtifact(absolutePath);
    } catch {
      // Launch failure is non-fatal; keep the dashboard open.
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
    const artifacts = this.model.getArtifacts();
    reconcileAgyArtifactsSelection(this.selection, artifacts);

    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(6, rows - 5);
    const innerWidth = Math.max(0, width - 2);

    const lines: string[] = [];

    const headerLeft = theme.fg(
      "accent",
      theme.bold(
        this.preview ? `agy artifact · ${oneLine(this.preview.artifact.name)}` : "agy artifacts",
      ),
    );
    const headerRight = theme.fg("muted", this.preview ? "markdown" : `${artifacts.length}`);
    const headerPad = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4);
    lines.push(truncateToWidth(`  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `, width));

    lines.push(
      truncateToWidth(
        theme.fg("border", "╭") +
          this.borderSegment(
            innerWidth,
            this.busy ? "working…" : this.preview ? this.previewChecklistLabel() : "artifacts",
          ) +
          theme.fg("border", "╮"),
        width,
      ),
    );

    const divider = theme.fg("border", "│");
    const rowLines = this.preview
      ? this.renderPreview(innerWidth, bodyHeight)
      : this.renderRows(artifacts, innerWidth, bodyHeight);
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(
        truncateToWidth(divider + this.pad(rowLines[i] ?? "", innerWidth) + divider, width),
      );
    }

    lines.push(
      truncateToWidth(
        theme.fg("border", "╰") +
          theme.fg("border", "─".repeat(Math.max(0, innerWidth))) +
          theme.fg("border", "╯"),
        width,
      ),
    );

    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          this.preview
            ? `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk scroll · o open · ${configuredKeys(this.keybindings, "tui.select.cancel")} back`
            : `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · enter/v preview markdown · o open · r rescan · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`,
        ),
        width,
      ),
    );

    return lines;
  }

  private previewChecklistLabel(): string {
    if (!this.preview) return "preview";
    const { completed, total, truncated } = this.preview.content;
    if (total === 0) return truncated ? "preview · truncated" : "preview";
    return truncated
      ? `preview · checklist ${completed}/${total} partial · truncated`
      : `preview · checklist ${completed}/${total}`;
  }

  private renderPreview(width: number, height: number): string[] {
    if (!this.preview) return [];
    const marker = this.preview.content.truncated
      ? "\n\n[Preview truncated at 256 KiB; checklist counts are partial.]"
      : "";
    const source = stripTerminalSequences(`${this.preview.content.text}${marker}`)
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "    ")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    const wrapped = source
      .split("\n")
      .flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width - 2)) : [""]));
    const maxScroll = Math.max(0, wrapped.length - height);
    this.preview.scroll = Math.min(this.preview.scroll, maxScroll);
    return wrapped
      .slice(this.preview.scroll, this.preview.scroll + height)
      .map((line) => truncateToWidth(` ${line}`, width, ""));
  }

  private renderRows(
    artifacts: ReadonlyArray<AgyArtifact>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];

    let start = 0;
    if (artifacts.length > height) {
      start = Math.min(
        Math.max(0, this.selection.index - Math.floor(height / 2)),
        artifacts.length - height,
      );
    }
    const visible = artifacts.slice(start, start + height);

    for (let i = 0; i < visible.length; i++) {
      const artifact = visible[i];
      const index = start + i;
      const isSelected = index === this.selection.index;

      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const glyph =
        artifact.kind === "generated"
          ? theme.fg("success", "◆")
          : artifact.kind === "conversation"
            ? theme.fg("accent", "◆")
            : theme.fg("muted", "◇");
      const title = isSelected
        ? theme.fg("accent", oneLine(artifact.name))
        : theme.fg("text", oneLine(artifact.name));
      const left = ` ${marker} ${glyph} ${title}`;

      const dot = theme.fg("dim", " · ");
      const rightParts = [
        theme.fg("muted", artifact.mediaType),
        theme.fg("muted", formatBytes(artifact.bytes)),
        theme.fg("muted", artifact.kind),
      ];
      const right = `${rightParts.join(dot)} `;

      const rightWidth = visibleWidth(right);
      const leftMax = Math.max(0, width - rightWidth - 2);
      out.push(
        truncateToWidth(left, leftMax) +
          " ".repeat(
            Math.max(1, width - visibleWidth(truncateToWidth(left, leftMax)) - rightWidth),
          ) +
          right,
      );
    }
    return out;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
