import assert from "node:assert/strict";
import test from "node:test";
import { parseAnswer, verdictOf } from "../lib/answer.ts";

test("parseAnswer reads the last line that answers", () => {
  assert.equal(parseAnswer("推导……\n答案：21颗"), 21);
  assert.equal(parseAnswer("答案: 21"), 21);
  assert.equal(parseAnswer("**答案：21颗**"), 21);
  assert.equal(parseAnswer("  答案： 21 颗"), 21);
});

test("parseAnswer ignores a correct aside about the blind answer", () => {
  // The failure the loose pattern alone would make: a right answer that also
  // mentions 29 must stay 21, because the last line answers.
  assert.equal(parseAnswer("答案：21颗（若不能靠手感分辨形状，答案是 29 颗）"), 21);
  assert.equal(parseAnswer("答案：21 颗。若不分辨形状，最少 29 颗。"), 21);
  assert.equal(parseAnswer("先算盲取：至少需要 29 颗；但题目允许分辨形状。\n答案：21颗"), 21);
});

test("parseAnswer falls back to an answer buried in prose", () => {
  assert.equal(parseAnswer("因此最少需要 21 颗，因为……"), 21);
  assert.equal(parseAnswer("最少取出 21 个"), 21);
});

test("parseAnswer reports no answer when there is none", () => {
  assert.equal(parseAnswer(""), undefined);
  assert.equal(parseAnswer("我需要更多信息才能计算。"), undefined);
  assert.equal(parseAnswer("答案：很多"), undefined);
});

test("verdictOf names the two answers that matter", () => {
  assert.equal(verdictOf(21), "ok");
  assert.equal(verdictOf(29), "blind");
  assert.equal(verdictOf(28), "wrong");
  assert.equal(verdictOf(undefined), "no-answer");
});
