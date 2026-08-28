import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agyIncompleteToolError,
  isSummarizationRequest,
  latestUserPrompt,
  mapThinkingToEffort,
  mapUsage,
  piHistoryBootstrap,
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
    {
      role: "user",
      content: [
        { type: "text", text: "second" },
        { type: "text", text: "line2" },
      ],
    },
  ]);
  const { prompt, images } = latestUserPrompt(ctx);
  assert.equal(prompt, "second\nline2");
  assert.equal(images, 0);
});

test("latestUserPrompt notes omitted images", () => {
  const ctx = contextWith([
    {
      role: "user",
      content: [
        { type: "image", data: "..." },
        { type: "text", text: "look" },
      ],
    },
  ]);
  const { prompt, images } = latestUserPrompt(ctx);
  assert.equal(images, 1);
  assert.ok(prompt.includes("look"));
  assert.ok(prompt.includes("image(s) omitted"));
});

test("latestUserPrompt returns empty when there is no user message", () => {
  assert.equal(latestUserPrompt(contextWith([])).prompt, "");
});

test("piHistoryBootstrap restores the active branch before the current request", () => {
  const restored = piHistoryBootstrap(
    contextWith([
      { role: "user", content: [{ type: "text", text: "Use SQLite." }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect it." },
          { type: "toolCall", name: "read", arguments: { path: "db.ts" } },
        ],
      },
      {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "export const db = ..." }],
      },
      { role: "user", content: [{ type: "text", text: "Continue." }] },
    ]),
  );
  assert.ok(restored);
  assert.match(restored, /Restored pi conversation context/);
  assert.match(restored, /Use SQLite/);
  assert.match(restored, /tool call: read/);
  assert.match(restored, /export const db/);
  assert.doesNotMatch(restored, /Continue/);
});

test("piHistoryBootstrap is absent for a first-turn request and bounds old history", () => {
  assert.equal(
    piHistoryBootstrap(
      contextWith([{ role: "user", content: [{ type: "text", text: "First request" }] }]),
    ),
    undefined,
  );
  const restored = piHistoryBootstrap(
    contextWith([
      { role: "user", content: [{ type: "text", text: "x".repeat(30_000) }] },
      { role: "assistant", content: [{ type: "text", text: "tail" }] },
      { role: "user", content: [{ type: "text", text: "now" }] },
    ]),
  );
  assert.ok(restored);
  assert.match(restored, /Earlier history omitted/);
  assert.ok(restored.length < 25_000);
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

test("isSummarizationRequest recognizes pi compaction prompts only", () => {
  assert.ok(isSummarizationRequest("<conversation>\nuser: hi\n</conversation>\n\nSummarize…"));
  // Ordinary prompts — including ones that merely mention the tag — bill normally.
  assert.ok(!isSummarizationRequest("fix the <conversation> parser"));
  assert.ok(!isSummarizationRequest("Summarize this conversation"));
});

test("mapThinkingToEffort maps pi thinking levels to agy effort", () => {
  assert.equal(mapThinkingToEffort(undefined), undefined);
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
  const replay = new AgyReplayStore();
  const streamFn = streamAntigravity(
    fakeRuntime as any,
    fakeService as any,
    replay,
    new AgyPiBridge("test-bridge"),
  );
  const model: Model<string> = {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    provider: "antigravity",
    api: "antigravity-stream-json",
    cost: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0.3 },
  } as any;

  const createStream = () => {
    const ctx = contextWith([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    return streamFn(model, ctx);
  };
  /** Start a turn; resolves with all events once the stream ends. */
  const collect = async (): Promise<any[]> => {
    const events: any[] = [];
    for await (const event of createStream()) events.push(event);
    return events;
  };
  return { controller, collect, createStream, replay };
}

test("streamAntigravity renders a pending bash card on run_command ACTIVE", async () => {
  const { controller, createStream, replay } = makeStreamHarness();
  const iterator = createStream()[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, "start");

  controller.push({
    type: "tool_start",
    stepId: 7,
    name: "run_command",
    args: { CommandLine: "sleep 8" },
  });
  const started = (await iterator.next()).value;
  assert.equal(started.type, "toolcall_start");
  const pending = started.partial.content[started.contentIndex];
  assert.equal(pending.name, "antigravity");
  assert.deepEqual(pending.arguments, {
    tool: "run_command",
    input: { CommandLine: "sleep 8" },
  });
  assert.equal(replay.size, 0, "result is not replayable before agy finishes");

  controller.push({
    type: "tool_done",
    stepId: 7,
    name: "run_command",
    args: { CommandLine: "sleep 8" },
    output: "done",
    durationSeconds: 8,
  });
  const terminalEvents: any[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    terminalEvents.push(next.value);
  }
  const ended = terminalEvents.find((event) => event.type === "toolcall_end");
  const done = terminalEvents.find((event) => event.type === "done");
  assert.equal(ended.toolCall.id, pending.id);
  assert.equal(done.reason, "toolUse");
  assert.equal(replay.take(pending.id)?.output, "done");
});

test("streamAntigravity chooses native execution only after a successful agy tool result", async () => {
  const { controller, collect, replay } = makeStreamHarness();
  const eventsPromise = collect();
  controller.push({
    type: "tool_start",
    stepId: 1,
    name: "view_file",
    args: { AbsolutePath: "/tmp/a.ts" },
  });
  controller.push({
    type: "tool_done",
    stepId: 1,
    name: "view_file",
    args: { AbsolutePath: "/tmp/a.ts" },
    output: "ok",
  });

  const events = await eventsPromise;
  const done = events.find((event) => event.type === "done");
  const toolCall = done?.message.content.find((part: any) => part.type === "toolCall");
  assert.equal(toolCall?.name, "read");
  assert.deepEqual(toolCall?.arguments, { path: "/tmp/a.ts" });
  assert.equal(replay.size, 0);
});

test("streamAntigravity replays native-tool errors instead of re-executing them", async () => {
  const { controller, collect, replay } = makeStreamHarness();
  const eventsPromise = collect();
  controller.push({
    type: "tool_start",
    stepId: 1,
    name: "view_file",
    args: { AbsolutePath: "/missing" },
  });
  controller.push({
    type: "tool_error",
    stepId: 1,
    name: "view_file",
    args: { AbsolutePath: "/missing" },
    message: "not found",
  });

  const events = await eventsPromise;
  const done = events.find((event) => event.type === "done");
  const toolCall = done?.message.content.find((part: any) => part.type === "toolCall");
  assert.equal(toolCall?.name, "antigravity");
  assert.equal(replay.take(toolCall.id)?.error, "not found");
  assert.equal(replay.size, 0);
});

test("streamAntigravity reports cumulative agy usage exactly once across tool cards", async () => {
  const { controller, collect } = makeStreamHarness();
  for (const activity of [
    { type: "usage", usage: { input_tokens: 13_712, output_tokens: 264, total_tokens: 13_976 } },
    { type: "tool_start", stepId: 1, name: "view_file", args: { AbsolutePath: "/tmp/a" } },
    {
      type: "tool_done",
      stepId: 1,
      name: "view_file",
      args: { AbsolutePath: "/tmp/a" },
      output: "ok",
    },
    { type: "tool_start", stepId: 2, name: "run_command", args: { CommandLine: "echo hi" } },
    {
      type: "tool_error",
      stepId: 2,
      name: "run_command",
      args: { CommandLine: "echo hi" },
      message: "denied",
    },
    {
      type: "result",
      status: "ERROR",
      response: "",
      error: "permission denied",
      usage: { input_tokens: 44_909, output_tokens: 610, total_tokens: 45_519 },
    },
  ] as const) {
    controller.push(activity);
  }

  const messages = [];
  for (let i = 0; i < 3; i++) {
    const events = await collect();
    const terminal = events.find((event) => event.type === "done" || event.type === "error");
    messages.push(terminal.type === "done" ? terminal.message : terminal.error);
  }
  assert.deepEqual(
    messages.map((message) => message.usage.totalTokens),
    [13_976, 0, 31_543],
  );
  assert.equal(
    messages.reduce((sum, message) => sum + message.usage.totalTokens, 0),
    45_519,
  );
});

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
  assert.equal(
    doneEvent.message.content[0].text,
    "All custom agent integration features are fully implemented.",
  );
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
