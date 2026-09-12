import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { DevinReplayStore } from "../lib/replay.ts";
import { streamDevin } from "../src/provider.ts";
import { DevinTurnController, type DevinActivity } from "../src/turn.ts";
import type { DevinRuntimeInstance, DevinRuntimeShape } from "../src/runtime.ts";
import type { DevinModelFamily } from "../lib/models.ts";

const FAMILIES: DevinModelFamily[] = [
  {
    id: "swe-2",
    name: "SWE-2",
    aliases: [],
    rows: [
      {
        id: "swe-2-medium",
        name: "SWE-2 Medium",
        contextWindow: 262_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        effort: "medium",
      },
      {
        id: "swe-2-max",
        name: "SWE-2 Max",
        contextWindow: 262_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        effort: "max",
      },
    ],
  },
];

/** Drive a canned activity sequence through a real controller. */
function fakeRuntime(
  activities: DevinActivity[],
  capture: { prompts?: number; summaryModelId?: string } = {},
) {
  const controllers: DevinTurnController[] = [];
  const service = {
    beginStreamTurn: () => {
      capture.prompts = (capture.prompts ?? 0) + 1;
      const controller = new DevinTurnController("do it", "sess-1");
      controllers.push(controller);
      // Push on the next tick so the provider's drain loop is waiting.
      queueMicrotask(() => {
        for (const activity of activities) controller.push(activity);
        controller.push({ type: "result", stopReason: "end_turn" });
        controller.close();
      });
      return controller;
    },
    finishTurn: { pipe: () => ({}) },
    runSummaryTurn: (_prompt: string, _signal: unknown, modelId?: string) => {
      capture.summaryModelId = modelId;
      return Promise.resolve({ text: "summary" });
    },
  } as unknown as DevinRuntimeShape;
  const runtime = {
    runPromise: (effect: unknown) =>
      // The fake service returns plain values, not Effects — runPromise gets
      // called with the fake's return; make it passthrough-friendly.
      Promise.resolve(
        typeof effect === "object" && effect && "pipe" in effect ? undefined : effect,
      ),
    runPromiseExit: async () => ({ _tag: "Success", value: undefined }),
    dispose: async () => {},
  } as unknown as DevinRuntimeInstance;
  return { service, runtime, controllers, capture };
}

const MODEL = {
  id: "swe-2",
  name: "SWE-2",
  api: "devin-acp",
  provider: "devin",
  baseUrl: "devin://acp",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262_000,
  maxTokens: 64_000,
} as const;

const CONTEXT = {
  systemPrompt: undefined,
  messages: [{ role: "user", content: "do it" }],
} as never;

async function drain(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("streamDevin emits text deltas then done", async () => {
  const { service, runtime } = fakeRuntime([
    { type: "thought", delta: "hmm", messageId: "t1" },
    { type: "text", delta: "Hello", messageId: "m1" },
    { type: "text", delta: " world", messageId: "m1" },
    {
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 5, contextUsed: 15, contextSize: 262000 },
    },
  ]);
  const replay = new DevinReplayStore();
  const stream = streamDevin({
    runtime,
    service,
    replay,
    families: () => FAMILIES,
    cwd: () => "/tmp",
  })(MODEL as never, CONTEXT, undefined);
  const events = await drain(stream);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("thinking_start"));
  assert.ok(types.includes("text_start"));
  assert.equal(events.filter((e) => e.type === "text_delta").length, 2);
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.message.stopReason, "stop");
  assert.equal(done.message.usage.input, 10);
  assert.equal(done.message.usage.output, 5);
});

test("streamDevin ends with toolUse after a completed tool call and replays the result", async () => {
  const { service, runtime } = fakeRuntime([
    {
      type: "tool_start",
      view: { id: "write_1", title: "Wrote /tmp/x", kind: "edit", tool: "write" },
    },
    {
      type: "tool_update",
      view: {
        id: "write_1",
        title: "Wrote /tmp/x",
        kind: "edit",
        tool: "write",
        status: "completed",
        output: "done",
      },
    },
  ]);
  const replay = new DevinReplayStore();
  const stream = streamDevin({
    runtime,
    service,
    replay,
    families: () => FAMILIES,
    cwd: () => "/tmp",
  })(MODEL as never, CONTEXT, undefined);
  const events = await drain(stream);
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.reason, "toolUse");
  const toolCalls = done.message.content.filter((c) => c.type === "toolCall");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "devin");
  // The replay store holds the recorded result for pi's wrapper execution.
  const recorded = replay.take(toolCalls[0].id);
  assert.equal(recorded?.output, "done");
  assert.equal(recorded?.title, "Wrote /tmp/x");
});

test("non-terminal tool updates keep the card pending; the terminal update closes it once", async () => {
  const { service, runtime } = fakeRuntime([
    {
      type: "tool_start",
      view: { id: "cmd_1", title: "Ran tests", kind: "execute", tool: "shell" },
    },
    {
      type: "tool_update",
      view: { id: "cmd_1", status: "in_progress", output: "partial…" },
    },
    {
      type: "tool_update",
      view: { id: "cmd_1", status: "in_progress", output: "still running" },
    },
    {
      type: "tool_update",
      view: { id: "cmd_1", status: "completed", output: "all passed" },
    },
  ]);
  const replay = new DevinReplayStore();
  const stream = streamDevin({
    runtime,
    service,
    replay,
    families: () => FAMILIES,
    cwd: () => "/tmp",
  })(MODEL as never, CONTEXT, undefined);
  const events = await drain(stream);
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.reason, "toolUse");
  const toolCalls = done.message.content.filter((c) => c.type === "toolCall");
  assert.equal(toolCalls.length, 1, "one card despite progress updates");
  // Exactly one start/end pair for that card.
  assert.equal(events.filter((e) => e.type === "toolcall_start").length, 1);
  assert.equal(events.filter((e) => e.type === "toolcall_end").length, 1);
  const recorded = replay.take(toolCalls[0].id);
  assert.equal(recorded?.output, "all passed");
});

test("a background shell left open at turn end replays as a note, not an error", async () => {
  const { service, runtime } = fakeRuntime([
    {
      type: "tool_start",
      view: { id: "exec_0", title: "Ran sleep 60", kind: "execute", tool: "exec" },
    },
    {
      type: "tool_update",
      view: {
        id: "exec_0",
        status: "in_progress",
        background: true,
        shellId: "444264",
        output: "bg started (pid 63007)",
      },
    },
  ]);
  const replay = new DevinReplayStore();
  const stream = streamDevin({
    runtime,
    service,
    replay,
    families: () => FAMILIES,
    cwd: () => "/tmp",
  })(MODEL as never, CONTEXT, undefined);
  const events = await drain(stream);
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.reason, "toolUse", "sweep ends the segment for replay");
  const toolCall = done.message.content.find((c) => c.type === "toolCall");
  assert.ok(toolCall && toolCall.type === "toolCall");
  const recorded = replay.take(toolCall.id);
  assert.equal(recorded?.error, undefined, "background shell is not a failure");
  assert.match(recorded?.output ?? "", /background shell 444264/);
  assert.match(recorded?.output ?? "", /bg started \(pid 63007\)/);
});

test("usage merge never clobbers known fields and honors the prompt response", async () => {
  const { service, runtime } = fakeRuntime([
    {
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3 },
    },
    // A context-only usage_update (no token counters) must not zero them.
    { type: "usage", usage: { contextUsed: 15, contextSize: 262000 } },
    {
      type: "result",
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 6 },
    },
  ]);
  const stream = streamDevin({
    runtime,
    service,
    replay: new DevinReplayStore(),
    families: () => FAMILIES,
    cwd: () => "/tmp",
  })(MODEL as never, CONTEXT, undefined);
  const events = await drain(stream);
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  // devin inputTokens includes cachedReadTokens; pi usage.input is fresh-only.
  assert.equal(done.message.usage.input, 9);
  assert.equal(done.message.usage.output, 6);
  assert.equal(done.message.usage.cacheRead, 3);
  assert.equal(done.message.usage.totalTokens, 15);
});

test("summarization requests run in a disposable session with the resolved model", async () => {
  const capture: { summaryModelId?: string } = {};
  const { service, runtime } = fakeRuntime([], capture);
  const stream = streamDevin({
    runtime,
    service,
    replay: new DevinReplayStore(),
    families: () => FAMILIES,
    cwd: () => "/tmp",
  })(
    MODEL as never,
    {
      systemPrompt: undefined,
      messages: [{ role: "user", content: "<conversation>\nprior chat\n</conversation>" }],
    } as never,
    undefined,
  );
  const events = await drain(stream);
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.message.stopReason, "stop");
  assert.equal(done.message.content[0]?.type, "text");
  // The family's default row (medium) is forwarded to the disposable session.
  assert.equal(capture.summaryModelId, "swe-2-medium");
});

test("turns without usage_update still report the prompt-response usage", async () => {
  const { service, runtime } = fakeRuntime([
    { type: "result", stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 4 } },
  ]);
  const stream = streamDevin({
    runtime,
    service,
    replay: new DevinReplayStore(),
    families: () => FAMILIES,
    cwd: () => "/tmp",
  })(MODEL as never, CONTEXT, undefined);
  const events = await drain(stream);
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.message.usage.input, 7);
  assert.equal(done.message.usage.output, 4);
});
