import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import askUser, { type AskUserInput } from "../index.ts";
import { AskUserForm, type AskUserQuestion, type AskUserSubmission } from "../lib/form.ts";
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
    matches: (data: string, keybinding: string) => bindings[keybinding]?.includes(data) ?? false,
  } as KeybindingsManager;
}

function createForm(questions: AskUserQuestion[]) {
  let renders = 0;
  let result: AskUserSubmission | null | undefined;
  const tui = {
    requestRender: () => {
      renders++;
    },
    terminal: { rows: 24, cols: 80 },
  } as unknown as TUI;
  const form = new AskUserForm(tui, createTheme(), createKeybindings(), questions, (submission) => {
    result = submission;
  });
  return {
    form,
    getResult: () => result,
    getRenderCount: () => renders,
  };
}

const longQuestion: AskUserQuestion = {
  question:
    "This is a deliberately long architectural question with enough context to require several wrapped lines while preserving the final QUESTION_END marker.",
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
  assert.match(lines.join("\n"), /› {3}1\. Redis/);
  assert.doesNotMatch(lines.join("\n"), /\[/);
  assert.match(lines.join("\n"), /Space select/);
});

test("left and right preserve answers while space selects and enter submits", () => {
  const questions: AskUserQuestion[] = [
    {
      question: "Choose the deployment target",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
    {
      question: "Choose the validation suite",
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
  assert.match(firstQuestionAgain, /→ 1\. Staging/);
  assert.doesNotMatch(firstQuestionAgain, /\[/);
  assert.match(firstQuestionAgain, /Question 1 of 2 · 2 answered/);

  form.handleInput("enter"); // next, preserving the second question's cursor/answer
  assert.match(form.render(80).join("\n"), /→ 2\. Integration/);
  form.handleInput("enter"); // submit

  assert.deepEqual(getResult(), {
    answers: [
      {
        questionIndex: 1,
        question: "Choose the deployment target",
        choice: { label: "Staging", optionIndex: 1, wasCustom: false },
      },
      {
        questionIndex: 2,
        question: "Choose the validation suite",
        choice: { label: "Integration", optionIndex: 2, wasCustom: false },
      },
    ],
  });
});

test("number keys answer a question and advance to the next one", () => {
  const { form, getResult } = createForm([
    {
      question: "Choose the deployment target",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
    {
      question: "Choose the validation suite",
      options: [{ label: "Unit" }, { label: "Integration" }, { label: "End-to-end" }],
    },
  ]);

  const firstRender = form.render(80).join("\n");
  assert.match(firstRender, /› {3}1\. Staging/);
  assert.match(firstRender, /1-3 pick/);

  form.handleInput("2"); // Production, then next question
  const secondRender = form.render(80).join("\n");
  assert.match(secondRender, /Question 2 of 2 · 1 answered/);
  assert.doesNotMatch(secondRender, /→ \d+\./);

  form.handleInput("1"); // Unit, then submit the completed form

  assert.deepEqual(getResult(), {
    answers: [
      {
        questionIndex: 1,
        question: "Choose the deployment target",
        choice: { label: "Production", optionIndex: 2, wasCustom: false },
      },
      {
        questionIndex: 2,
        question: "Choose the validation suite",
        choice: { label: "Unit", optionIndex: 1, wasCustom: false },
      },
    ],
  });
});

test("the Other row is numbered and opens the editor", () => {
  const { form, getResult } = createForm([
    {
      question: "Choose a cache",
      options: [{ label: "Redis" }, { label: "SQLite" }],
    },
  ]);

  form.handleInput("3"); // Other
  assert.match(form.render(80).join("\n"), /Your answer:/);

  // Digits typed in the editor must reach the editor, not pick a row.
  for (const character of "Keep 2 replicas") form.handleInput(character);
  form.handleInput("\r");
  assert.equal(getResult(), undefined);
  assert.match(form.render(80).join("\n"), /→ 3\. Other — Keep 2 replicas/);

  form.handleInput("enter");
  assert.deepEqual(getResult()?.answers[0].choice, {
    label: "Keep 2 replicas",
    wasCustom: true,
  });
});

test("numbers outside the option count are ignored", () => {
  const { form, getResult, getRenderCount } = createForm([
    {
      question: "Choose one",
      options: [{ label: "First" }, { label: "Second" }],
    },
  ]);

  form.handleInput("7");

  assert.equal(getResult(), undefined);
  assert.equal(getRenderCount(), 0);
  const rendered = form.render(80).join("\n");
  assert.doesNotMatch(rendered, /→/);
  assert.match(rendered, /› {3}1\. First/);
  assert.match(rendered, /1-3 pick/);
});

test("selecting another option replaces the earlier choice", () => {
  const { form, getResult } = createForm([
    {
      question: "Choose one",
      options: [{ label: "First" }, { label: "Second" }],
    },
  ]);

  form.handleInput(" ");
  form.handleInput("down");
  form.handleInput(" ");
  form.handleInput("enter");

  assert.deepEqual(getResult()?.answers[0].choice, {
    label: "Second",
    optionIndex: 2,
    wasCustom: false,
  });
});

test("Other accepts an inline custom answer before form submission", () => {
  const { form, getResult } = createForm([
    {
      question: "Choose a cache",
      options: [{ label: "Redis" }, { label: "SQLite" }],
    },
  ]);

  form.handleInput(" "); // Redis
  form.handleInput("down");
  form.handleInput("down");
  form.handleInput(" ");
  for (const character of "Use the database directly") form.handleInput(character);
  form.handleInput("\r");

  assert.equal(getResult(), undefined);
  assert.match(form.render(80).join("\n"), /→ 3\. Other — Use the database directly/);

  form.handleInput("enter");
  assert.deepEqual(getResult()?.answers[0].choice, {
    label: "Use the database directly",
    wasCustom: true,
  });
});

test("enter refuses to advance an unanswered question and renders guidance", () => {
  const { form, getResult, getRenderCount } = createForm([longQuestion]);

  form.handleInput("enter");

  assert.equal(getResult(), undefined);
  assert.ok(getRenderCount() > 0);
  assert.match(form.render(60).join("\n"), /Select an option before continuing/);
});

test("legacy single-question arguments upgrade to questions[]", () => {
  let registered: { prepareArguments?: (args: unknown) => AskUserInput } | undefined;
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
        choice: { label: "Redis", optionIndex: 1, wasCustom: false },
      },
      {
        questionIndex: 2,
        question: "Anything else?",
        choice: { label: "Keep it local", wasCustom: true },
      },
    ],
  });

  assert.equal(text, "Question 1: selected option 1: Redis\nQuestion 2: wrote: Keep it local");
});
