import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  askUserCollapsedLines,
  askUserExpandedBody,
  askUserQuestionCount,
} from "../extensions/renderer/tool/ask-user-question.ts";

initTheme("dark");

// Minimal theme stub: the renderer only needs fg().
const theme = {
  fg: (_color: string, text: string) => text,
};

const strip = (lines: string[]) =>
  lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));

// The shape `@tian.zuo/pi-ask-user` actually returns.
const ourResult = {
  content: [{ type: "text", text: "User answered 2 questions." }],
  details: {
    questions: [
      { question: "Pick a database", options: ["Postgres", "SQLite"] },
      { question: "Anything else?", options: ["Yes", "No"] },
    ],
    answers: [
      {
        questionIndex: 0,
        question: "Pick a database",
        choice: { label: "Postgres", optionIndex: 0, wasCustom: false },
      },
      {
        questionIndex: 1,
        question: "Anything else?",
        choice: { label: "write tests first", wasCustom: true },
      },
    ],
    cancelled: false,
  },
};

test("ask_user renders the collapsed answer tree", () => {
  const lines = strip(
    askUserCollapsedLines({ result: ourResult, theme, isError: false, width: 100 }),
  );
  assert.equal(lines.length, 3, "two answer rows plus the summary row");
  assert.match(lines[0], /Pick a database/);
  assert.match(lines[0], /Postgres/);
  assert.match(lines[1], /Anything else\?/);
  assert.match(lines[1], /write tests first/);
  assert.match(lines[2], /2 answered/);
  // Every row must fit the requested width.
  for (const line of lines) {
    assert.ok(line.length <= 100, `line too wide: ${line.length}`);
  }
});

test("ask_user reports the question count before any result arrives", () => {
  const args = { questions: [{ question: "a" }, { question: "b" }, { question: "c" }] };
  assert.equal(askUserQuestionCount(undefined, args), 3);
  assert.equal(askUserQuestionCount(ourResult, args), 2);
  assert.equal(askUserQuestionCount(undefined, {}), undefined);
});

test("ask_user expanded body lists each question with its answer", () => {
  const body = askUserExpandedBody(ourResult);
  assert.match(body, /Pick a database\n {2}Postgres/);
  assert.match(body, /Anything else\?\n {2}write tests first/);
});

test("ask_user renders a dismissed result without answers", () => {
  const lines = strip(
    askUserCollapsedLines({
      result: { details: { answers: [], cancelled: true } },
      theme,
      isError: false,
      width: 80,
    }),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Declined/);
});

test("ask_user tree stays within a narrow width", () => {
  const lines = strip(
    askUserCollapsedLines({ result: ourResult, theme, isError: false, width: 24 }),
  );
  for (const line of lines) {
    assert.ok(line.length <= 24, `line too wide (${line.length}): ${line}`);
  }
});
