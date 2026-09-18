import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { DevinReplayStore } from "../lib/replay.ts";
import { mapUsage, streamDevin } from "../src/provider.ts";
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
  capture: {
    prompts?: number;
    summaryModelId?: string;
    turnRequest?: Record<string, unknown>;
  } = {},
) {
  const controllers: DevinTurnController[] = [];
  const service = {
    beginStreamTurn: (request: Record<string, unknown>) => {
      capture.prompts = (capture.prompts ?? 0) + 1;
      capture.turnRequest = request;
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
      return Promise.resolve({ text: "summary", usage: { inputTokens: 5, outputTokens: 2 } });
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

for (const status of ["completed", "failed"]) {
  test(`initial ${status} tool notifications produce terminal replay cards`, async () => {
    const { service, runtime, controllers } = fakeRuntime([
      { type: "tool_start", view: { id: "one", title: "one", status, output: "actual result" } },
    ]);
    const replay = new DevinReplayStore();
    const message = await streamDevin({
      runtime,
      service,
      replay,
      families: () => FAMILIES,
      cwd: () => "/tmp",
    })(MODEL as never, CONTEXT).result();
    assert.equal(message.stopReason, "toolUse");
    const call = message.content.find((c) => c.type === "toolCall");
    assert.ok(call);
    const recorded = replay.take(call.id);
    assert.equal(recorded?.output, "actual result");
    assert.equal(recorded?.error, status === "failed" ? "actual result" : undefined);
    assert.deepEqual(controllers[0].takeIncompleteTools(), []);
  });
}

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

test("request snapshots accumulate once; the prompt-response echo dedups", async () => {
  const { service, runtime } = fakeRuntime([
    {
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3 },
    },
    // Devin emits every request's update twice — identical repeats count once.
    {
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 3 },
    },
    // A context-only usage_update (no token counters) is not billable.
    { type: "usage", usage: { contextUsed: 15, contextSize: 262000 } },
    // A second request's snapshot accumulates on top of the first.
    {
      type: "usage",
      usage: { inputTokens: 12, outputTokens: 6, cachedReadTokens: 3 },
    },
    // The prompt response echoes the last request's snapshot — deduped.
    {
      type: "result",
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 6, cachedReadTokens: 3 },
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
  // Bills {inputTokens:22, outputTokens:11, cachedReadTokens:6} once —
  // devin inputTokens is cache-inclusive; pi usage.input is fresh-only.
  assert.equal(done.message.usage.input, 16);
  assert.equal(done.message.usage.output, 11);
  assert.equal(done.message.usage.cacheRead, 6);
  // totalTokens is the reported context occupancy (15), not the billed sum.
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
  // The throwaway summary session's usage is recorded on the message.
  assert.equal(done.message.usage.input, 5);
  assert.equal(done.message.usage.output, 2);
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

test("each segment bills its request's usage; the turn sums to the total", async () => {
  // Delta billing: every replay segment persists only the turn's
  // not-yet-billed share, so pi's footer fills live while the session log
  // still sums to the turn's full billable total.
  const controller = new DevinTurnController("do it", "sess-1");
  const waves: DevinActivity[][] = [
    [
      { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } },
      {
        type: "tool_start",
        view: { id: "cmd_0", title: "Ran build", kind: "execute", tool: "shell" },
      },
      { type: "tool_update", view: { id: "cmd_0", status: "completed", output: "ok" } },
    ],
    [
      {
        type: "usage",
        usage: { inputTokens: 150, outputTokens: 35, cachedReadTokens: 90 },
      },
      {
        type: "tool_start",
        view: { id: "cmd_1", title: "Ran tests", kind: "execute", tool: "shell" },
      },
      { type: "tool_update", view: { id: "cmd_1", status: "completed", output: "pass" } },
    ],
    [
      // The last request's update lands just before the prompt response,
      // which echoes it — consecutive-identical dedup counts it once.
      { type: "usage", usage: { inputTokens: 200, outputTokens: 50 } },
      { type: "result", stopReason: "end_turn", usage: { inputTokens: 200, outputTokens: 50 } },
    ],
  ];
  let wave = 0;
  const service = {
    beginStreamTurn: () => {
      queueMicrotask(() => {
        for (const activity of waves[wave] ?? []) controller.push(activity);
        wave += 1;
        if (wave >= waves.length) controller.close();
      });
      return controller;
    },
    finishTurn: { pipe: () => ({}) },
    runSummaryTurn: () => Promise.resolve({ text: "summary" }),
  } as unknown as DevinRuntimeShape;
  const runtime = {
    runPromise: (effect: unknown) => Promise.resolve(effect),
    runPromiseExit: async () => ({ _tag: "Success", value: undefined }),
    dispose: async () => {},
  } as unknown as DevinRuntimeInstance;
  const run = () =>
    streamDevin({
      runtime,
      service,
      replay: new DevinReplayStore(),
      families: () => FAMILIES,
      cwd: () => "/tmp",
    })(
      { ...MODEL, cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 } } as never,
      CONTEXT,
    ).result();

  const segment1 = await run();
  assert.equal(segment1.stopReason, "toolUse");
  assert.equal(segment1.usage.input, 100);
  assert.equal(segment1.usage.output, 20);
  // totalTokens is context occupancy (last request's size), not a delta.
  assert.equal(segment1.usage.totalTokens, 120);
  assert.ok(Math.abs(segment1.usage.cost.total - 0.00028) < 1e-12);

  const segment2 = await run();
  assert.equal(segment2.stopReason, "toolUse");
  // devin inputTokens is cache-inclusive; pi input is the fresh portion.
  assert.equal(segment2.usage.input, 60);
  assert.equal(segment2.usage.output, 35);
  assert.equal(segment2.usage.cacheRead, 90);
  assert.equal(segment2.usage.totalTokens, 185);
  assert.ok(Math.abs(segment2.usage.cost.total - 0.00035) < 1e-12);

  const final = await run();
  assert.equal(final.stopReason, "stop");
  assert.equal(final.usage.input, 200);
  assert.equal(final.usage.output, 50);
  assert.equal(final.usage.totalTokens, 250);
  assert.ok(Math.abs(final.usage.cost.total - 0.0006) < 1e-12);

  const billed = (u: typeof segment1.usage) => u.input + u.output + u.cacheRead + u.cacheWrite;
  const sum = billed(segment1.usage) + billed(segment2.usage) + billed(final.usage);
  assert.equal(sum, 555, "segments sum to the turn's full billable total");
});

test("cache writes are classified separately without double counting", () => {
  const usage = mapUsage({
    inputTokens: 200,
    outputTokens: 50,
    cachedReadTokens: 90,
    cachedWriteTokens: 30,
  });
  assert.equal(usage.input, 80);
  assert.equal(usage.cacheRead, 90);
  assert.equal(usage.cacheWrite, 30);
  // No occupancy report: totalTokens falls back to the request's own size.
  assert.equal(usage.totalTokens, 250);
});

test("totalTokens reports devin's context occupancy scaled to the model window", () => {
  // Devin's usage_update carries `used`/`size`; pi's compaction threshold
  // and context gauge consume totalTokens as "tokens in this model's
  // window", so occupancy is scaled when the windows differ.
  const usage = mapUsage(
    {
      inputTokens: 999999,
      outputTokens: 999,
      contextUsed: 524288,
      contextSize: 1048576,
    },
    262144,
  );
  assert.equal(usage.totalTokens, 131072);
  // A matching window passes occupancy through untouched.
  assert.equal(mapUsage({ contextUsed: 50000, contextSize: 262144 }, 262144).totalTokens, 50000);
  // Without a reported size the raw value is the best available estimate.
  assert.equal(mapUsage({ contextUsed: 50000 }, 262144).totalTokens, 50000);
});

test("persisted tool card arguments carry the terminal view, not the call start", async () => {
  const { service, runtime } = fakeRuntime([
    { type: "tool_start", view: { id: "read_0", title: "Read file", kind: "read" } },
    {
      type: "tool_update",
      view: { id: "read_0", status: "completed", locations: ["/tmp/x.ts"], output: "body" },
    },
  ]);
  const message = await streamDevin({
    runtime,
    service,
    replay: new DevinReplayStore(),
    families: () => FAMILIES,
    cwd: () => "/tmp",
  })(MODEL as never, CONTEXT).result();
  const call = message.content.find((c) => c.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  // pi persists `output.content`, so the card must be updated in place: the
  // start view had no locations, the terminal view does.
  assert.equal((call.arguments as { summary?: string }).summary, "read · /tmp/x.ts");
});

test("pi's payload hook sees the ACP prompt and can replace it", async () => {
  const capture: { turnRequest?: Record<string, unknown> } = {};
  const { service, runtime } = fakeRuntime([], capture);
  const seen: unknown[] = [];
  const stream = streamDevin({
    runtime,
    service,
    replay: new DevinReplayStore(),
    families: () => FAMILIES,
    cwd: () => "/tmp",
  })(MODEL as never, CONTEXT, {
    onPayload: async (payload) => {
      seen.push(payload);
      return { ...(payload as object), prompt: [{ type: "text", text: "rewritten" }] };
    },
  });
  await stream.result();
  // The runtime invokes the transform with the real ACP session + prompt.
  const transform = capture.turnRequest?.transformPrompt as
    | ((request: { sessionId: string; prompt: unknown[] }) => Promise<unknown>)
    | undefined;
  assert.equal(typeof transform, "function");
  const replaced = await transform?.({
    sessionId: "sess-1",
    prompt: [{ type: "text", text: "hi" }],
  });
  assert.deepEqual(seen, [{ sessionId: "sess-1", prompt: [{ type: "text", text: "hi" }] }]);
  assert.deepEqual(replaced, [{ type: "text", text: "rewritten" }]);
});
