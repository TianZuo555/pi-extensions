import assert from "node:assert/strict";
import test from "node:test";
import { latestCheckpoint } from "../src/checkpoint.ts";
import { requestTextCompaction } from "../src/text-compact.ts";
import { harness, openaiLuna, openaiSol, requestPayload, textResponse } from "./fixtures.ts";

test("new OpenAI OAuth summarizes on Luna 6, without either blocked remote operation", async () => {
  const h = harness({
    model: openaiSol,
    settings: { compactionModel: "gpt-6-luna" },
    fetch: async (input, init) => {
      assert.equal(String(input), "https://api.openai.com/v1/responses");
      assert.match(new Headers(init?.headers).get("authorization")!, /^Bearer /);
      return textResponse();
    },
  });
  const event = h.event();
  event.customInstructions = "Preserve audit codes: focus-sentinel";
  event.preparation.previousSummary = "Previous summary: old decision";
  event.preparation.fileOps.read.add("/src/read.ts");
  event.preparation.fileOps.edited.add("/src/changed.ts");
  const result = await h.compact(event);
  assert(result?.compaction);
  assert.equal(result.compaction.firstKeptEntryId, h.keptId);
  assert.equal(result.compaction.tokensBefore, 100);
  assert.equal(result.compaction.usage?.totalTokens, 11);
  assert.match(result.compaction.summary, /old-123/);
  assert.deepEqual(result.compaction.details, {
    readFiles: ["/src/read.ts"],
    modifiedFiles: ["/src/changed.ts"],
  });
  assert.equal(h.payloads[0].model, openaiLuna.id);
  const payload = JSON.stringify(h.payloads[0]);
  assert.match(payload, /focus-sentinel/);
  assert.match(payload, /Previous summary: old decision/);
  assert.match(payload, /old-user-code/);
  assert.equal(payload.includes("recent-user-code"), false);
  assert.equal(payload.includes("compaction_trigger"), false);
  assert.equal(payload.includes("prompt_cache_key"), false);
  assert.equal(payload.includes('"tools"'), false);
  const { summary, firstKeptEntryId, tokensBefore, details } = result.compaction;
  h.sm.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, true);
  assert.equal(latestCheckpoint(h.sm.getBranch()), undefined);
  assert.equal(
    await h.call("context", { messages: h.sm.buildSessionContext().messages }),
    undefined,
  );
  assert.equal(await h.call("before_provider_request", { payload: { input: [] } }), undefined);
  assert.match(h.notifications[0], /does not support remote compaction.*gpt-6-luna/);
});

test("new-auth warning appears once per session, even when ordinary fallback warnings are off", async () => {
  const h = harness({ model: openaiSol, settings: { notifyOnFallback: false } });
  assert((await h.compact())?.compaction);
  assert((await h.compact())?.compaction);
  assert.equal(h.notifications.length, 1);
  await h.call("session_start", {});
  assert((await h.compact())?.compaction);
  assert.equal(h.notifications.length, 2);
});

test("text fallback refuses to replace an existing Codex checkpoint", async () => {
  const h = harness({ prior: true, model: openaiSol });
  const before = structuredClone(h.sm.getBranch());
  assert.deepEqual(await h.compact(), { cancel: true });
  assert.deepEqual(h.sm.getBranch(), before);
  assert.equal(h.payloads.length, 0);
  assert.match(h.notifications[0], /preserving the existing opaque checkpoint/);
});

test("explicit lossy opt-in permits replacement by a text summary", async () => {
  const h = harness({
    prior: true,
    model: openaiSol,
    settings: { allowLossyNativeFallback: true },
  });
  assert((await h.compact())?.compaction);
  assert.match(h.notifications[0], /Opaque checkpoint history will be dropped/);
});

test("OpenAI API keys and disabled settings keep Pi's normal native compaction", async () => {
  for (const options of [{ oauth: false }, { settings: { enabled: false } }]) {
    const h = harness({ model: openaiSol, ...options });
    assert.equal(await h.compact(), undefined);
    assert.equal(h.payloads.length, 0);
  }
});

test("text summarization still handles split turns using Pi's two-summary flow", async () => {
  const h = harness({ model: openaiSol });
  const event = h.event();
  event.preparation.isSplitTurn = true;
  event.preparation.turnPrefixMessages = [
    { role: "user", content: "split-turn-sentinel", timestamp: 3 },
  ];
  const result = await h.compact(event);
  assert(result?.compaction);
  assert.match(result.compaction.summary, /Turn Context \(split turn\)/);
  assert.equal(h.payloads.length, 2);
  assert.match(JSON.stringify(h.payloads[1]), /split-turn-sentinel/);
  assert.equal(result.compaction.usage?.totalTokens, 22);
});

test("failed or empty text summaries fall back without persisting a checkpoint", async () => {
  for (const response of [
    () => new Response("temporarily unavailable", { status: 503 }),
    () => textResponse(""),
  ]) {
    const h = harness({ model: openaiSol, fetch: async () => response() });
    const event = h.event();
    event.preparation.fileOps.read.add("/src/read.ts");
    assert.equal(await h.compact(event), undefined);
    assert.equal(
      h.sm.getBranch().some((entry) => entry.type === "compaction"),
      false,
    );
    assert.match(h.notifications.at(-1)!, /using Pi compaction/);
  }
});

test("shutdown aborts an in-flight text summary and cancels compaction", async () => {
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const h = harness({
    model: openaiSol,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        started();
      }),
  });
  const pending = h.compact();
  await ready;
  await h.call("session_shutdown", {});
  assert.deepEqual(await pending, { cancel: true });
});

test("text deadline covers a stalled body, not just HTTP headers", { timeout: 5000 }, async () => {
  const h = harness({ model: openaiSol });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      requestTextCompaction(
        h.event(),
        h.ctx,
        openaiLuna,
        { ...h.settings, requestTimeoutMs: 50 },
        new AbortController().signal,
        async (_input, init) => {
          assert.equal(requestPayload(init).model, openaiLuna.id);
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                timer = setTimeout(() => controller.close(), 4000);
              },
              cancel() {
                clearTimeout(timer);
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      ),
      /Text compaction timed out after 50ms/,
    );
  } finally {
    clearTimeout(timer);
  }
});
