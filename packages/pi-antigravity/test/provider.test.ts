import assert from "node:assert/strict";
import { test } from "node:test";
import { latestUserPrompt, mapUsage } from "../src/provider.ts";
import { newTurnOutcome } from "../lib/reducer.ts";
import type { Context } from "@earendil-works/pi-ai";

function contextWith(messages: unknown[]): Context {
  return { messages } as Context;
}

test("latestUserPrompt extracts the last user text", () => {
  const ctx = contextWith([
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: [{ type: "text", text: "second" }, { type: "text", text: "line2" }] },
  ]);
  const { prompt, images } = latestUserPrompt(ctx);
  assert.equal(prompt, "second\nline2");
  assert.equal(images, 0);
});

test("latestUserPrompt notes omitted images", () => {
  const ctx = contextWith([
    { role: "user", content: [{ type: "image", data: "..." }, { type: "text", text: "look" }] },
  ]);
  const { prompt, images } = latestUserPrompt(ctx);
  assert.equal(images, 1);
  assert.ok(prompt.includes("look"));
  assert.ok(prompt.includes("image(s) omitted"));
});

test("latestUserPrompt returns empty when there is no user message", () => {
  assert.equal(latestUserPrompt(contextWith([])).prompt, "");
});

test("mapUsage maps agy usage fields to pi usage", () => {
  const outcome = newTurnOutcome();
  outcome.usage = {
    input_tokens: 44909,
    output_tokens: 610,
    thinking_tokens: 395,
    cache_read_tokens: 7,
    total_tokens: 45519,
  };
  const usage = mapUsage(outcome);
  assert.equal(usage.input, 44909);
  assert.equal(usage.output, 610);
  assert.equal(usage.cacheRead, 7);
  assert.equal(usage.cacheWrite, 0);
  assert.equal(usage.totalTokens, 45519);
});

test("mapUsage defaults to zeros without usage", () => {
  const usage = mapUsage(newTurnOutcome());
  assert.equal(usage.input, 0);
  assert.equal(usage.totalTokens, 0);
});
