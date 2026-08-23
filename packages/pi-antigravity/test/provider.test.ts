import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agyIncompleteToolError,
  latestUserPrompt,
  mapThinkingToEffort,
  mapUsage,
  streamAntigravity,
} from "../src/provider.ts";
import { AgyTurnController } from "../lib/turn.ts";
import { AgyReplayStore } from "../lib/replay.ts";
import { AgyPiBridge } from "../lib/bridge.ts";
import { Effect } from "effect";
import type { Context, Model } from "@earendil-works/pi-ai";

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
  const usage = mapUsage({
    input_tokens: 44909,
    output_tokens: 610,
    thinking_tokens: 395,
    cache_read_tokens: 7,
    total_tokens: 45519,
  });
  assert.equal(usage.input, 44909);
  assert.equal(usage.output, 610);
  assert.equal(usage.cacheRead, 7);
  assert.equal(usage.cacheWrite, 0);
  assert.equal(usage.totalTokens, 45519);
});

test("mapUsage defaults to zeros without usage", () => {
  const usage = mapUsage(undefined);
  assert.equal(usage.input, 0);
  assert.equal(usage.totalTokens, 0);
});

test("mapThinkingToEffort maps pi thinking levels to agy effort", () => {
  assert.equal(mapThinkingToEffort(undefined), "high");
  assert.equal(mapThinkingToEffort("minimal"), "low");
  assert.equal(mapThinkingToEffort("low"), "low");
  assert.equal(mapThinkingToEffort("medium"), "medium");
  assert.equal(mapThinkingToEffort("high"), "high");
  assert.equal(mapThinkingToEffort("xhigh"), "high");
  assert.equal(mapThinkingToEffort("max"), "high");
});

test("agyIncompleteToolError explains agy background tasks for run_command", () => {
  const bg = agyIncompleteToolError("run_command", "timeout waiting for response");
  assert.match(bg, /background task/);
  assert.match(bg, /keeps running/);

  // Unknown stream end for run_command still gets the background hint.
  assert.match(agyIncompleteToolError("run_command"), /background task/);

  // Other tools and unrelated errors keep the generic message.
  assert.equal(
    agyIncompleteToolError("search_web", "timeout waiting for response"),
    "agy tool call did not complete.",
  );
  assert.equal(
    agyIncompleteToolError("run_command", "permission check failed"),
    "agy tool call did not complete.",
  );
});

/** Harness for stream-level tests: a turn controller behind a fake runtime. */
function makeStreamHarness() {
  const controller = new AgyTurnController("hello");
  const fakeService = {
    beginStreamTurn: () => Effect.succeed(controller),
    finishTurn: Effect.void,
    pushBridgeCall: () => false,
    reset: Effect.void,
    snapshot: Effect.succeed({
      conversationId: undefined,
      model: undefined,
      cwd: undefined,
      turns: 0,
    }),
    close: Effect.void,
    setSession: () => Effect.void,
  };
  const fakeRuntime = { runPromise: () => Promise.resolve(controller) };
  const streamFn = streamAntigravity(
    fakeRuntime as any,
    fakeService as any,
    new AgyReplayStore(),
    new AgyPiBridge("test-bridge"),
  );
  const model: Model<string> = {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    provider: "antigravity",
    api: "antigravity-stream-json",
    cost: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0.3 },
  } as any;

  /** Start a turn; resolves with all events once the stream ends. */
  const collect = async (): Promise<any[]> => {
    const ctx = contextWith([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    const events: any[] = [];
    for await (const event of streamFn(model, ctx)) events.push(event);
    return events;
  };
  return { controller, collect };
}

test("streamAntigravity treats result with ERROR status as success when response is present (recovered stream interruption)", async () => {
  const { controller, collect } = makeStreamHarness();
  const eventsPromise = collect();

  // Push an ERROR result event that contains a valid response (recovered stream interruption)
  controller.push({
    type: "result",
    status: "ERROR",
    error: "The stream was interrupted. Please continue the task you were working on.",
    response: "All custom agent integration features are fully implemented.",
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  });

  const events = await eventsPromise;
  const doneEvent = events.find((e) => e.type === "done");
  const errorEvent = events.find((e) => e.type === "error");

  assert.ok(doneEvent, "Expected done event when response text is present");
  assert.equal(errorEvent, undefined, "Expected no error event when response text is present");
  assert.equal(doneEvent.reason, "stop");
  assert.equal(doneEvent.message.stopReason, "stop");
  assert.equal(doneEvent.message.errorMessage, undefined);
  assert.equal(doneEvent.message.content[0].text, "All custom agent integration features are fully implemented.");
});

test("streamAntigravity snaps text_end to the authoritative response when deltas drift", async () => {
  const { controller, collect } = makeStreamHarness();
  const eventsPromise = collect();

  // Streamed deltas drift from agy's authoritative final response.
  controller.push({ type: "text", delta: "streamed partial" });
  controller.push({
    type: "result",
    status: "OK",
    error: undefined,
    response: "authoritative final text",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  });

  const events = await eventsPromise;
  const textEnd = events.find((e) => e.type === "text_end");
  const doneEvent = events.find((e) => e.type === "done");

  assert.ok(textEnd, "Expected a text_end event");
  assert.equal(textEnd.content, "authoritative final text");
  assert.ok(doneEvent);
  assert.equal(doneEvent.message.content[0].text, "authoritative final text");
});

test("streamAntigravity fails turn when result has ERROR status and no response", async () => {
  const { controller, collect } = makeStreamHarness();
  const eventsPromise = collect();

  // Push an ERROR result event with empty response (actual failure)
  controller.push({
    type: "result",
    status: "ERROR",
    error: "permission check failed for command",
    response: "",
    usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
  });

  const events = await eventsPromise;
  const doneEvent = events.find((e) => e.type === "done");
  const errorEvent = events.find((e) => e.type === "error");

  assert.equal(doneEvent, undefined);
  assert.ok(errorEvent, "Expected error event when response is empty");
  assert.equal(errorEvent.error.stopReason, "error");
  assert.ok(errorEvent.error.errorMessage.includes("permission check failed"));
});

test("streamAntigravity fails turn when ERROR is not a recovered interruption, even with response text", async () => {
  const { controller, collect } = makeStreamHarness();
  const eventsPromise = collect();

  // Partial text plus an unrelated agy failure must not pass silently.
  controller.push({
    type: "result",
    status: "ERROR",
    error: "timeout waiting for response",
    response: "Partial answer before the failure.",
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  });

  const events = await eventsPromise;
  const doneEvent = events.find((e) => e.type === "done");
  const errorEvent = events.find((e) => e.type === "error");

  assert.equal(doneEvent, undefined);
  assert.ok(errorEvent, "Expected error event for non-interruption ERROR despite response text");
  assert.equal(errorEvent.error.stopReason, "error");
  assert.ok(errorEvent.error.errorMessage.includes("timeout waiting for response"));
});
