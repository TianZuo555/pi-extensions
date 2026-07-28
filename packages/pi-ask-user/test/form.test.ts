import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import askUser, { type AskUserInput } from "../index.ts";
import {
  AskUserForm,
  type AskUserQuestion,
  type AskUserSubmission,
} from "../lib/form.ts";
import { buildAskUserResultMessage } from "../lib/prompt.ts";

function createTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
}

function createKeybindings(): KeybindingsManager {
  const bindings: Record<string, string[]> = {
    "tui.select.cancel": ["escape"],
    "tui.select.up": ["up"],
    "tui.select.down": ["down"],
    "tui.select.confirm": ["enter"],
    "tui.editor.cursorLeft": ["left"],
    "tui.editor.cursorRight": ["right"],
  };
  return {
    matches: (data: string, keybinding: string) =>
      bindings[keybinding]?.includes(data) ?? false,
  } as KeybindingsManager;
}

function createForm(questions: AskUserQuestion[]) {
  let renders = 0;
  let result: AskUserSubmission | null | undefined;
  const tui = {
    requestRender: () => {
      renders++;
    },
  } as unknown as TUI;
  const form = new AskUserForm(
    tui,
    createTheme(),
    createKeybindings(),
    questions,
    (submission) => {
      result = submission;
    },
  );
  return {
    form,
    getResult: () => result,
    getRenderCount: () => renders,
  };
}

const longQuestion: AskUserQuestion = {
  question:
    "This is a deliberately long architectural question with enough context to require several wrapped lines while preserving the final QUESTION_END marker.",
  allowMultiple: false,
  options: [
    {
      label: "Redis (recommended)",
      description:
        "An in-memory key-value store with TTL support, shared cache behavior, operational trade-offs, and a final DESCRIPTION_END marker.",
    },
    {
      label: "SQLite file cache",
      description:
        "A single-file embedded database suited to local development and small deployments.",
    },
  ],
};

test("long questions and option descriptions wrap without clipping", () => {
  const { form } = createForm([longQuestion]);
  const lines = form.render(42);

  assert.ok(lines.every((line) => visibleWidth(line) <= 42));
  assert.match(lines.join("\n"), /QUESTION_END/);
  assert.match(lines.join("\n"), /DESCRIPTION_END/);
  assert.match(lines.join("\n"), /› \[ \] Redis/);
  assert.match(lines.join("\n"), /Space select/);
});

test("left and right preserve answers while space selects and enter submits", () => {
  const questions: AskUserQuestion[] = [
    {
      question: "Choose the deployment target",
      allowMultiple: false,
      options: [{ label: "Staging" }, { label: "Production" }],
    },
    {
      question: "Choose the validation suites",
      allowMultiple: true,
      options: [{ label: "Unit" }, { label: "Integration" }, { label: "End-to-end" }],
    },
  ];
  const { form, getResult } = createForm(questions);

  form.handleInput(" "); // Staging
  form.handleInput("right");
  form.handleInput("down");
  form.handleInput(" "); // Integration
  form.handleInput("left");

  const firstQuestionAgain = form.render(80).join("\n");
  assert.match(firstQuestionAgain, /\[x\] Staging/);
  assert.match(firstQuestionAgain, /Question 1 of 2 · 2 answered/);

  form.handleInput("enter"); // next, preserving the second question's cursor/answer
  form.handleInput("up");
  form.handleInput(" "); // Unit + Integration
  form.handleInput("enter"); // submit

  assert.deepEqual(getResult(), {
    answers: [
      {
        questionIndex: 1,
        question: "Choose the deployment target",
        choices: [{ label: "Staging", optionIndex: 1, wasCustom: false }],
      },
      {
        questionIndex: 2,
        question: "Choose the validation suites",
        choices: [
          { label: "Unit", optionIndex: 1, wasCustom: false },
          { label: "Integration", optionIndex: 2, wasCustom: false },
        ],
      },
    ],
  });
});

test("single-select space replaces an earlier choice", () => {
  const { form, getResult } = createForm([
    {
      question: "Choose one",
      allowMultiple: false,
      options: [{ label: "First" }, { label: "Second" }],
    },
  ]);

  form.handleInput(" ");
  form.handleInput("down");
  form.handleInput(" ");
  form.handleInput("enter");

  assert.deepEqual(getResult()?.answers[0].choices, [
    { label: "Second", optionIndex: 2, wasCustom: false },
  ]);
});

test("Other accepts an inline custom answer before form submission", () => {
  const { form, getResult } = createForm([
    {
      question: "Choose a cache",
      allowMultiple: false,
      options: [{ label: "Redis" }, { label: "SQLite" }],
    },
  ]);

  form.handleInput("down");
  form.handleInput("down");
  form.handleInput(" ");
  for (const character of "Use the database directly") form.handleInput(character);
  form.handleInput("\r");

  assert.equal(getResult(), undefined);
  assert.match(form.render(80).join("\n"), /\[x\] Other — Use the database directly/);

  form.handleInput("enter");
  assert.deepEqual(getResult()?.answers[0].choices, [
    { label: "Use the database directly", wasCustom: true },
  ]);
});

test("enter refuses to advance an unanswered question and renders guidance", () => {
  const { form, getResult, getRenderCount } = createForm([longQuestion]);

  form.handleInput("enter");

  assert.equal(getResult(), undefined);
  assert.ok(getRenderCount() > 0);
  assert.match(form.render(60).join("\n"), /Select an option before continuing/);
});

test("legacy single-question arguments upgrade to questions[]", () => {
  let registered:
    | { prepareArguments?: (args: unknown) => AskUserInput }
    | undefined;
  const pi = {
    registerTool: (tool: unknown) => {
      registered = tool as { prepareArguments?: (args: unknown) => AskUserInput };
    },
  } as unknown as ExtensionAPI;
  askUser(pi);

  const prepared = registered?.prepareArguments?.({
    question: "Legacy question",
    options: [{ label: "One" }, { label: "Two" }],
  });

  assert.deepEqual(prepared, {
    questions: [
      {
        question: "Legacy question",
        options: [{ label: "One" }, { label: "Two" }],
      },
    ],
  });
});

test("result text reports every selected and custom answer", () => {
  const text = buildAskUserResultMessage({
    kind: "answered",
    answers: [
      {
        questionIndex: 1,
        question: "Cache?",
        choices: [{ label: "Redis", optionIndex: 1, wasCustom: false }],
      },
      {
        questionIndex: 2,
        question: "Anything else?",
        choices: [{ label: "Keep it local", wasCustom: true }],
      },
    ],
  });

  assert.equal(
    text,
    "Question 1: selected option 1: Redis\nQuestion 2: wrote: Keep it local",
  );
});
