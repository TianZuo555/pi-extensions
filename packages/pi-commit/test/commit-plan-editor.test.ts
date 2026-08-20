import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  CommitPlanEditor,
  commitPlanEntryLabel,
  type CommitPlanEditorEntry,
} from "../lib/commit-plan-editor.ts";
import type { CommitPlan } from "../lib/prompt.ts";

const ENTER = "\r";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";

function createTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
}

function createKeybindings(): KeybindingsManager {
  const bindings: Record<string, string[]> = {
    "tui.select.cancel": ["\x1b"],
    "tui.editor.cursorLeft": [LEFT],
    "tui.editor.cursorRight": [RIGHT],
    "tui.editor.cursorUp": [UP],
    "tui.editor.cursorDown": [DOWN],
  };
  return {
    matches: (data: string, keybinding: string) =>
      bindings[keybinding]?.includes(data) ?? false,
  } as KeybindingsManager;
}

function createTui(): TUI {
  return {
    requestRender: () => {},
    terminal: { rows: 24, cols: 80 },
  } as unknown as TUI;
}

function createEditor(commits: CommitPlanEditorEntry[]) {
  let result: CommitPlan | null | undefined;
  const editor = new CommitPlanEditor(
    createTui(),
    createTheme(),
    createKeybindings(),
    commits,
    (submission) => {
      result = submission;
    },
  );
  editor.focused = true;
  return {
    editor,
    getResult: () => result,
  };
}

function moveCursorToEnd(editor: CommitPlanEditor, length: number): void {
  for (let index = 0; index < length; index++) {
    editor.handleInput(RIGHT);
  }
}

test("commitPlanEntryLabel summarizes single and multi-file commits", () => {
  assert.equal(commitPlanEntryLabel(["src/a.ts"]), "src/a.ts");
  assert.equal(commitPlanEntryLabel(["src/a.ts", "src/b.ts"]), "2 files");
});

test("up and down always switch commits and preserve edits", () => {
  const commits: CommitPlanEditorEntry[] = [
    { paths: ["src/a.ts"], message: "feat: first" },
    { paths: ["src/b.ts", "src/c.ts"], message: "feat: second" },
  ];
  const { editor } = createEditor(commits);

  editor.handleInput(DOWN);
  editor.handleInput("X");
  editor.handleInput(UP);

  const rendered = stripTerminalSequences(editor.render(80).join("\n"));
  assert.match(rendered, /Edit commit message 1\/2 \(src\/a\.ts\)/);
  assert.match(rendered, /feat: first/);

  editor.handleInput(DOWN);
  assert.match(
    stripTerminalSequences(editor.render(80).join("\n")),
    /feat: secondX/,
  );
});

test("left and right stay free for cursor movement inside the message", () => {
  const commits: CommitPlanEditorEntry[] = [
    { paths: ["src/a.ts"], message: "feat: first" },
    { paths: ["src/b.ts"], message: "feat: second" },
  ];
  const { editor } = createEditor(commits);

  moveCursorToEnd(editor, "feat: first".length);
  editor.handleInput(RIGHT);
  editor.handleInput(LEFT);

  const rendered = stripTerminalSequences(editor.render(80).join("\n"));
  assert.match(rendered, /Edit commit message 1\/2 \(src\/a\.ts\)/);
  assert.match(rendered, /feat: first/);
});

test("enter finishes a multi-commit plan when the last message is submitted", () => {
  const commits: CommitPlanEditorEntry[] = [
    { paths: ["src/a.ts"], message: "feat: first" },
    { paths: ["src/b.ts"], message: "feat: second" },
  ];
  const { editor, getResult } = createEditor(commits);

  editor.handleInput(ENTER);
  editor.handleInput(ENTER);

  assert.deepEqual(getResult(), {
    commits: [
      { paths: ["src/a.ts"], message: "feat: first" },
      { paths: ["src/b.ts"], message: "feat: second" },
    ],
  });
});

test("enter advances through commits and rejects empty messages on finish", () => {
  const commits: CommitPlanEditorEntry[] = [
    { paths: ["src/a.ts"], message: "feat: first" },
    { paths: ["src/b.ts"], message: "feat: second" },
  ];
  const { editor, getResult } = createEditor(commits);

  editor.handleInput(ENTER);
  for (let index = 0; index < "feat: second".length; index++) {
    editor.handleInput(BACKSPACE);
  }
  editor.handleInput(ENTER);

  assert.equal(getResult(), undefined);
  assert.match(editor.render(80).join("\n"), /cannot be empty/i);
});

test("long commit labels wrap without exceeding the render width", () => {
  const commits: CommitPlanEditorEntry[] = [
    {
      paths: ["packages/pi-commit/lib/commit-plan-editor.ts"],
      message: "feat: add navigable commit plan editor",
    },
    {
      paths: ["packages/pi-commit/index.ts"],
      message: "feat: wire commit plan editor into /commit-all",
    },
  ];
  const { editor } = createEditor(commits);
  const lines = editor.render(42);

  assert.ok(lines.every((line) => visibleWidth(line) <= 42));
  assert.match(lines.join("\n"), /packages\/pi-commit\/lib\/commit-plan-editor/);
});
