import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { normalizeEditedCommitMessage, type CommitPlan } from "./prompt.ts";

export interface CommitPlanEditorEntry {
  paths: readonly string[];
  message: string;
}

export function commitPlanEntryLabel(paths: readonly string[]): string {
  return paths.length === 1 ? paths[0] : `${paths.length} files`;
}

export function isCursorAtTextStart(editor: {
  getCursor(): { line: number; col: number };
}): boolean {
  const cursor = editor.getCursor();
  return cursor.line === 0 && cursor.col === 0;
}

export function isCursorAtTextEnd(editor: {
  getCursor(): { line: number; col: number };
  getLines(): string[];
}): boolean {
  const cursor = editor.getCursor();
  const lines = editor.getLines();
  if (lines.length === 0) return true;
  const lastLine = lines.length - 1;
  const lastCol = lines[lastLine]?.length ?? 0;
  return cursor.line === lastLine && cursor.col >= lastCol;
}

function appendWrapped(
  lines: string[],
  width: number,
  prefix: string,
  text: string,
): void {
  const renderWidth = Math.max(1, width);
  const prefixWidth = visibleWidth(prefix);

  if (prefixWidth >= renderWidth) {
    lines.push(...wrapTextWithAnsi(`${prefix}${text}`, renderWidth));
    return;
  }

  const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
  const continuationPrefix = " ".repeat(prefixWidth);
  if (wrapped.length === 0) {
    lines.push(truncateToWidth(prefix, renderWidth, ""));
    return;
  }

  for (let index = 0; index < wrapped.length; index++) {
    lines.push(`${index === 0 ? prefix : continuationPrefix}${wrapped[index]}`);
  }
}

/**
 * Multi-commit message editor for /commit-all review.
 *
 * Left/right at the editor boundaries switch commits while preserving edits.
 * Enter advances to the next commit or submits on the last one.
 */
export class CommitPlanEditor implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private labels: string[];
  private messages: string[];
  private paths: ReadonlyArray<readonly string[]>;
  private done: (result: CommitPlan | null) => void;
  private signal: AbortSignal | undefined;
  private onAbort: (() => void) | undefined;
  private editor: Editor;

  private commitIndex = 0;
  private warning: string | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private _focused = false;
  private settled = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    commits: readonly CommitPlanEditorEntry[],
    done: (result: CommitPlan | null) => void,
    signal?: AbortSignal,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.labels = commits.map((commit) => commitPlanEntryLabel(commit.paths));
    this.messages = commits.map((commit) => commit.message);
    this.paths = commits.map((commit) => commit.paths);
    this.done = done;

    const editorTheme: EditorTheme = {
      borderColor: (text) => this.theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    };
    this.editor = new Editor(tui, editorTheme);
    this.editor.setText(this.messages[0] ?? "");
    this.editor.onSubmit = (value) => this.handleSubmit(value);

    this.signal = signal;
    if (signal) {
      this.onAbort = () => this.cancel();
      signal.addEventListener("abort", this.onAbort, { once: true });
      if (signal.aborted) queueMicrotask(this.onAbort);
    }
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  private refresh(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.tui.requestRender();
  }

  private saveCurrentMessage(): void {
    this.messages[this.commitIndex] = this.editor.getText();
  }

  private loadCurrentMessage(): void {
    this.editor.setText(this.messages[this.commitIndex] ?? "");
    this.editor.focused = this._focused;
  }

  private moveCommit(offset: number): void {
    const next = Math.min(
      this.messages.length - 1,
      Math.max(0, this.commitIndex + offset),
    );
    if (next === this.commitIndex) return;
    this.saveCurrentMessage();
    this.commitIndex = next;
    this.warning = undefined;
    this.loadCurrentMessage();
    this.refresh();
  }

  private handleSubmit(value: string): void {
    this.messages[this.commitIndex] = value;
    if (this.commitIndex < this.messages.length - 1) {
      this.commitIndex++;
      this.warning = undefined;
      this.loadCurrentMessage();
      this.refresh();
      return;
    }
    this.tryFinish();
  }

  private tryFinish(): void {
    const commits: CommitPlan["commits"] = [];
    for (let index = 0; index < this.messages.length; index++) {
      try {
        commits.push({
          paths: [...this.paths[index]],
          message: normalizeEditedCommitMessage(this.messages[index]),
        });
      } catch (error) {
        this.commitIndex = index;
        this.warning = error instanceof Error ? error.message : String(error);
        this.loadCurrentMessage();
        this.refresh();
        return;
      }
    }
    this.finish({ commits });
  }

  private finish(result: CommitPlan | null): void {
    if (this.settled) return;
    this.settled = true;
    if (this.signal && this.onAbort) {
      this.signal.removeEventListener("abort", this.onAbort);
    }
    this.done(result);
  }

  cancel(): void {
    this.finish(null);
  }

  handleInput(data: string): void {
    if (this.settled) return;

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.cancel();
      return;
    }

    if (
      matchesKey(data, Key.left) ||
      this.keybindings.matches(data, "tui.editor.cursorLeft")
    ) {
      if (isCursorAtTextStart(this.editor)) {
        this.moveCommit(-1);
        return;
      }
    }
    if (
      matchesKey(data, Key.right) ||
      this.keybindings.matches(data, "tui.editor.cursorRight")
    ) {
      if (isCursorAtTextEnd(this.editor)) {
        this.moveCommit(1);
        return;
      }
    }

    this.editor.handleInput(data);
    this.refresh();
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    if (this.cachedLines && this.cachedWidth === renderWidth) return this.cachedLines;

    const lines: string[] = [];
    const border = this.theme.fg("accent", "─".repeat(renderWidth));
    const label = this.labels[this.commitIndex] ?? "";
    const title = `Edit commit message ${this.commitIndex + 1}/${this.messages.length} (${label})`;

    lines.push(border);
    appendWrapped(lines, renderWidth, " ", this.theme.fg("accent", this.theme.bold(title)));

    if (this.messages.length > 1) {
      lines.push("");
      const tabs: string[] = ["← "];
      for (let index = 0; index < this.messages.length; index++) {
        const active = index === this.commitIndex;
        const tabLabel = `${index + 1}: ${this.labels[index]}`;
        const text = ` ${tabLabel} `;
        tabs.push(
          active
            ? this.theme.bg("selectedBg", this.theme.fg("text", text))
            : this.theme.fg("muted", text),
        );
        tabs.push(" ");
      }
      tabs.push("→");
      appendWrapped(lines, renderWidth, " ", tabs.join(""));
    }

    lines.push("");
    const childWidth = Math.max(1, renderWidth - 2);
    for (const line of this.editor.render(childWidth)) {
      lines.push(truncateToWidth(` ${line}`, renderWidth, ""));
    }

    if (this.warning) {
      lines.push("");
      appendWrapped(lines, renderWidth, " ", this.theme.fg("warning", this.warning));
    }

    lines.push("");
    const help =
      this.messages.length > 1
        ? "←/→ commit at line edge · Enter next/done · Shift+Enter newline · Esc cancel"
        : "Enter done · Shift+Enter newline · Esc cancel";
    appendWrapped(lines, renderWidth, " ", this.theme.fg("dim", help));
    lines.push(border);

    this.cachedWidth = renderWidth;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.editor.invalidate();
  }

  dispose(): void {
    if (this.signal && this.onAbort) {
      this.signal.removeEventListener("abort", this.onAbort);
    }
  }
}
