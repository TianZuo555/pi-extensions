import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASK_USER_TOOL_NAME,
  askUserCountSuffix,
  backgroundTerminalId,
  behavesLikeShell,
  hasAskUserAnswers,
  isAskUserCancelled,
  normalizeAnswers,
  rendererAliasFor,
  statusChipText,
  terminalToolDetail,
  terminalToolLineCount,
} from "../lib/our-tools.ts";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  isAskUserTool,
} from "../extensions/renderer/tool/ask-user-question.ts";

// --- ask_user (this repo) -------------------------------------------------

const ourAskUserResult = {
  details: {
    questions: [
      { question: "Pick a database", options: ["Postgres", "SQLite"] },
      { question: "Anything else?", options: ["Yes", "No"] },
    ],
    answers: [
      {
        questionIndex: 1,
        question: "Anything else?",
        choice: { label: "ship it", wasCustom: true },
      },
      {
        questionIndex: 0,
        question: "Pick a database",
        choice: { label: "Postgres", optionIndex: 0, wasCustom: false },
      },
    ],
    cancelled: false,
  },
};

// --- ask_user_question (upstream shape) ----------------------------------

const upstreamAskUserResult = {
  details: {
    answers: [
      { questionIndex: 0, question: "Pick a database", answer: "SQLite" },
      {
        questionIndex: 1,
        question: "Extras",
        kind: "multi",
        selected: ["tests", "docs"],
      },
    ],
  },
};

test("normalizeAnswers reads the @tian.zuo/pi-ask-user choice shape", () => {
  const answers = normalizeAnswers(ourAskUserResult);
  assert.deepEqual(answers, [
    { questionIndex: 0, question: "Pick a database", label: "Postgres", custom: false },
    { questionIndex: 1, question: "Anything else?", label: "ship it", custom: true },
  ]);
});

test("normalizeAnswers still reads the upstream answer/selected shape", () => {
  const answers = normalizeAnswers(upstreamAskUserResult);
  assert.equal(answers.length, 2);
  assert.equal(answers[0].label, "SQLite");
  assert.equal(answers[1].label, "tests, docs");
});

test("normalizeAnswers sorts by questionIndex and keeps unknown indexes last", () => {
  const result = {
    details: {
      answers: [
        { question: "no index" },
        { questionIndex: 2, question: "third", answer: "c" },
        { questionIndex: 0, question: "first", answer: "a" },
        { questionIndex: 1, question: "second", answer: "b" },
      ],
    },
  };
  assert.deepEqual(
    normalizeAnswers(result).map((answer) => answer.question),
    ["first", "second", "third", "no index"],
  );
});

test("normalizeAnswers tolerates a missing result", () => {
  assert.deepEqual(normalizeAnswers(undefined), []);
  assert.deepEqual(normalizeAnswers({}), []);
  assert.deepEqual(normalizeAnswers({ details: { answers: "nope" } }), []);
});

test("ask helpers report answers and cancellation", () => {
  assert.equal(hasAskUserAnswers(ourAskUserResult), true);
  assert.equal(hasAskUserAnswers({ details: {} }), false);
  assert.equal(isAskUserCancelled(ourAskUserResult), false);
  assert.equal(isAskUserCancelled({ details: { cancelled: true } }), true);
});

test("askUserCountSuffix reports the question count", () => {
  assert.equal(askUserCountSuffix(ourAskUserResult), " (2)");
  assert.equal(askUserCountSuffix({ details: { answers: [], cancelled: true } }), " (dismissed)");
  assert.equal(
    askUserCountSuffix({ details: { answers: [{ questionIndex: 0 }], cancelled: true } }),
    " (1, dismissed)",
  );
});

test("isAskUserTool accepts both tool names", () => {
  assert.equal(ASK_USER_TOOL_NAME, "ask_user");
  assert.equal(isAskUserTool("ask_user"), true);
  assert.equal(isAskUserTool(ASK_USER_QUESTION_TOOL_NAME), true);
  assert.equal(isAskUserTool("ask_user_question_extra"), false);
});

test("rendererAliasFor maps our ask_user onto the upstream renderer name", () => {
  assert.equal(rendererAliasFor("ask_user"), "ask_user_question");
  assert.equal(rendererAliasFor("bash"), undefined);
});

// --- background terminals ------------------------------------------------

test("behavesLikeShell covers the terminal tools only", () => {
  assert.equal(behavesLikeShell("terminal_wait"), true);
  assert.equal(behavesLikeShell("terminal_stop"), true);
  assert.equal(behavesLikeShell("terminal_log_read"), true);
  assert.equal(behavesLikeShell("bash"), false);
  assert.equal(behavesLikeShell("read"), false);
});

test("terminalToolDetail labels one or many ids", () => {
  assert.equal(terminalToolDetail({ ids: ["t1"] }), "t1");
  assert.equal(terminalToolDetail({ ids: ["t1", "t2", "t3"] }), "t1 (+2)");
  assert.equal(terminalToolDetail({ id: "solo" }), "solo");
  assert.equal(terminalToolDetail({}), undefined);
  assert.equal(terminalToolDetail(undefined), undefined);
});

test("terminalToolLineCount counts text content lines", () => {
  const result = {
    content: [{ type: "text", text: "one\ntwo\nthree" }],
  };
  assert.equal(terminalToolLineCount(result), 3);
  assert.equal(terminalToolLineCount({ content: [] }), 0);
  assert.equal(terminalToolLineCount({}), 0);
});

test("backgroundTerminalId finds the id in details", () => {
  assert.equal(backgroundTerminalId({ details: { terminalId: "abc" } }), "abc");
  assert.equal(backgroundTerminalId({ details: { terminal_id: "def" } }), "def");
  assert.equal(backgroundTerminalId({ details: {} }), undefined);
  assert.equal(backgroundTerminalId(undefined), undefined);
});

// --- footer status chips -------------------------------------------------

test("statusChipText normalizes our status keys", () => {
  assert.equal(statusChipText("token-speed", "42 tok/s"), "42 tok/s");
  assert.equal(statusChipText("usage", "Codex  80%\n"), "Codex  80%");
  assert.equal(statusChipText("token-speed", "   "), undefined);
  assert.equal(statusChipText("something-else", "x"), undefined);
});
