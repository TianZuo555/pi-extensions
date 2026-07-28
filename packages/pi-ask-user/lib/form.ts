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

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  question: string;
  options: AskUserOption[];
  allowMultiple: boolean;
}

export interface AskUserChoice {
  label: string;
  optionIndex?: number;
  wasCustom: boolean;
}

export interface AskUserAnswer {
  questionIndex: number;
  question: string;
  choices: AskUserChoice[];
}

export interface AskUserSubmission {
  answers: AskUserAnswer[];
}

interface MutableAnswer {
  optionIndices: Set<number>;
  customAnswer?: string;
}

const OTHER_LABEL = "Other";
const OTHER_DESCRIPTION = "type your own answer";

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
 * Interactive ask-user form.
 *
 * Navigation deliberately separates focus from selection: arrows only move,
 * Space selects/toggles, and Enter advances or submits. This keeps multi-select
 * questions predictable and lets users review earlier answers with Left/Right.
 */
export class AskUserForm implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private questions: AskUserQuestion[];
  private done: (result: AskUserSubmission | null) => void;
  private signal: AbortSignal | undefined;
  private onAbort: (() => void) | undefined;
  private editor: Editor;

  private questionIndex = 0;
  private optionIndices: number[];
  private answers: MutableAnswer[];
  private editMode = false;
  private warning: string | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private _focused = false;
  private settled = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    questions: AskUserQuestion[],
    done: (result: AskUserSubmission | null) => void,
    signal?: AbortSignal,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.questions = questions;
    this.done = done;
    this.signal = signal;
    this.optionIndices = questions.map(() => 0);
    this.answers = questions.map(() => ({ optionIndices: new Set<number>() }));

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
    this.editor.onSubmit = (value) => this.saveCustomAnswer(value);

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
    this.editor.focused = value && this.editMode;
  }

  private currentQuestion(): AskUserQuestion {
    return this.questions[this.questionIndex];
  }

  private currentAnswer(): MutableAnswer {
    return this.answers[this.questionIndex];
  }

  private currentOptionIndex(): number {
    return this.optionIndices[this.questionIndex];
  }

  private currentOptionCount(): number {
    return this.currentQuestion().options.length + 1;
  }

  private hasAnswer(index: number): boolean {
    const answer = this.answers[index];
    return answer.optionIndices.size > 0 || Boolean(answer.customAnswer);
  }

  private allAnswered(): boolean {
    return this.questions.every((_question, index) => this.hasAnswer(index));
  }

  private answeredCount(): number {
    return this.questions.filter((_question, index) => this.hasAnswer(index)).length;
  }

  private refresh(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.tui.requestRender();
  }

  private moveQuestion(offset: number): void {
    const next = Math.min(
      this.questions.length - 1,
      Math.max(0, this.questionIndex + offset),
    );
    if (next === this.questionIndex) return;
    this.questionIndex = next;
    this.warning = undefined;
    this.refresh();
  }

  private moveOption(offset: number): void {
    const current = this.currentOptionIndex();
    const next = Math.min(
      this.currentOptionCount() - 1,
      Math.max(0, current + offset),
    );
    if (next === current) return;
    this.optionIndices[this.questionIndex] = next;
    this.warning = undefined;
    this.refresh();
  }

  private toggleCurrentOption(): void {
    const question = this.currentQuestion();
    const answer = this.currentAnswer();
    const optionIndex = this.currentOptionIndex();

    if (optionIndex === question.options.length) {
      if (answer.customAnswer) {
        answer.customAnswer = undefined;
        this.warning = undefined;
        this.refresh();
        return;
      }
      this.editMode = true;
      this.warning = undefined;
      this.editor.setText("");
      this.editor.focused = this._focused;
      this.refresh();
      return;
    }

    if (question.allowMultiple) {
      if (answer.optionIndices.has(optionIndex)) {
        answer.optionIndices.delete(optionIndex);
      } else {
        answer.optionIndices.add(optionIndex);
      }
    } else if (
      answer.optionIndices.size === 1 &&
      answer.optionIndices.has(optionIndex) &&
      !answer.customAnswer
    ) {
      answer.optionIndices.clear();
    } else {
      answer.optionIndices.clear();
      answer.customAnswer = undefined;
      answer.optionIndices.add(optionIndex);
    }

    this.warning = undefined;
    this.refresh();
  }

  private saveCustomAnswer(value: string): void {
    const trimmed = value.trim();
    if (!trimmed) {
      this.editMode = false;
      this.editor.setText("");
      this.editor.focused = false;
      this.refresh();
      return;
    }

    const question = this.currentQuestion();
    const answer = this.currentAnswer();
    if (!question.allowMultiple) answer.optionIndices.clear();
    answer.customAnswer = trimmed;
    this.editMode = false;
    this.editor.setText("");
    this.editor.focused = false;
    this.warning = undefined;
    this.refresh();
  }

  private leaveEditor(): void {
    this.editMode = false;
    this.editor.setText("");
    this.editor.focused = false;
    this.warning = undefined;
    this.refresh();
  }

  private advanceOrSubmit(): void {
    if (!this.hasAnswer(this.questionIndex)) {
      this.warning = this.currentQuestion().allowMultiple
        ? "Select one or more options before continuing."
        : "Select an option before continuing.";
      this.refresh();
      return;
    }

    if (this.questionIndex < this.questions.length - 1) {
      this.questionIndex++;
      this.warning = undefined;
      this.refresh();
      return;
    }

    if (!this.allAnswered()) {
      const firstMissing = this.questions.findIndex((_question, index) => !this.hasAnswer(index));
      this.questionIndex = firstMissing;
      this.warning = "Answer this question before submitting.";
      this.refresh();
      return;
    }

    this.finish(this.buildSubmission());
  }

  private buildSubmission(): AskUserSubmission {
    return {
      answers: this.questions.map((question, questionIndex) => {
        const answer = this.answers[questionIndex];
        const choices: AskUserChoice[] = [...answer.optionIndices]
          .sort((left, right) => left - right)
          .map((optionIndex) => ({
            label: question.options[optionIndex].label,
            optionIndex: optionIndex + 1,
            wasCustom: false,
          }));
        if (answer.customAnswer) {
          choices.push({ label: answer.customAnswer, wasCustom: true });
        }
        return {
          questionIndex: questionIndex + 1,
          question: question.question,
          choices,
        };
      }),
    };
  }

  private finish(result: AskUserSubmission | null): void {
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

    if (this.editMode) {
      if (matchesKey(data, Key.escape)) {
        this.leaveEditor();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.cancel();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveOption(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveOption(1);
      return;
    }
    if (
      matchesKey(data, Key.left) ||
      this.keybindings.matches(data, "tui.editor.cursorLeft")
    ) {
      this.moveQuestion(-1);
      return;
    }
    if (
      matchesKey(data, Key.right) ||
      this.keybindings.matches(data, "tui.editor.cursorRight")
    ) {
      this.moveQuestion(1);
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.toggleCurrentOption();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.advanceOrSubmit();
    }
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    if (this.cachedLines && this.cachedWidth === renderWidth) return this.cachedLines;

    const lines: string[] = [];
    const question = this.currentQuestion();
    const answer = this.currentAnswer();
    const focusedOption = this.currentOptionIndex();
    const border = this.theme.fg("accent", "─".repeat(renderWidth));

    lines.push(border);
    appendWrapped(lines, renderWidth, " ", this.theme.fg("accent", this.theme.bold("Ask User")));
    lines.push("");

    const progress =
      this.questions.length > 1
        ? `Question ${this.questionIndex + 1} of ${this.questions.length} · ${this.answeredCount()} answered`
        : "Question 1 of 1";
    appendWrapped(lines, renderWidth, " ", this.theme.fg("muted", progress));
    lines.push("");

    appendWrapped(
      lines,
      renderWidth,
      this.theme.fg("muted", `${this.questionIndex + 1}. `),
      this.theme.fg("text", this.theme.bold(question.question)),
    );
    appendWrapped(
      lines,
      renderWidth,
      " ",
      this.theme.fg("dim", question.allowMultiple ? "Select one or more." : "Select one."),
    );
    lines.push("");

    for (let optionIndex = 0; optionIndex <= question.options.length; optionIndex++) {
      const isOther = optionIndex === question.options.length;
      const option = question.options[optionIndex];
      const focused = optionIndex === focusedOption;
      const checked = isOther
        ? Boolean(answer.customAnswer)
        : answer.optionIndices.has(optionIndex);
      const cursor = focused ? this.theme.fg("accent", "› ") : "  ";
      const checkbox = checked ? this.theme.fg("success", "[x] ") : this.theme.fg("muted", "[ ] ");
      const prefix = `${cursor}${checkbox}`;
      const label = isOther ? OTHER_LABEL : option.label;
      const description = isOther
        ? answer.customAnswer ?? OTHER_DESCRIPTION
        : option.description;
      const labelColor = focused ? "accent" : checked ? "text" : "muted";
      const descriptionColor = focused ? "accent" : "dim";
      const body =
        this.theme.fg(labelColor, label) +
        (description
          ? this.theme.fg(descriptionColor, ` — ${description}`)
          : "");
      appendWrapped(lines, renderWidth, prefix, body);
    }

    if (this.editMode) {
      lines.push("");
      appendWrapped(lines, renderWidth, " ", this.theme.fg("muted", "Your answer:"));
      const childWidth = Math.max(1, renderWidth - 2);
      for (const line of this.editor.render(childWidth)) {
        lines.push(truncateToWidth(` ${line}`, renderWidth, ""));
      }
    }

    if (this.warning) {
      lines.push("");
      appendWrapped(lines, renderWidth, " ", this.theme.fg("warning", this.warning));
    }

    lines.push("");
    const help = this.editMode
      ? "Enter save answer · Shift+Enter new line · Esc go back"
      : this.questions.length > 1
        ? "←/→ question · ↑/↓ option · Space select · Enter next/submit · Esc dismiss"
        : "↑/↓ option · Space select · Enter submit · Esc dismiss";
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
