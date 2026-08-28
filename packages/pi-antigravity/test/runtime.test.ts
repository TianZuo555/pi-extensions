import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgyTurnRequest } from "../lib/agy-client.ts";
import { newTurnOutcome, type AgyTurnOutcome } from "../lib/reducer.ts";
import { AntigravityRuntime, createAntigravityRuntime, runAntigravity } from "../src/runtime.ts";

function completedOutcome(conversationId: string): AgyTurnOutcome {
  return {
    ...newTurnOutcome(),
    conversationId,
    status: "OK",
    finished: true,
  };
}

test("runtime restores the selected pi branch only when starting a fresh conversation", async () => {
  const requests: AgyTurnRequest[] = [];
  const runtime = createAntigravityRuntime(async (request) => {
    requests.push(request);
    const conversationId = `conversation-${requests.length}`;
    request.onConversation?.(conversationId);
    return completedOutcome(conversationId);
  });
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined, true));
    const first = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "current request",
        historyBootstrap: "RESTORED PI BRANCH",
        bootstrapSuffix: "SKILL CATALOG",
        modelId: "gemini-3.7-flash",
        effort: "medium",
      }),
    );
    assert.equal(await first.next(), null);
    assert.equal(requests[0].prompt, "RESTORED PI BRANCH\n\ncurrent request\n\nSKILL CATALOG");
    assert.equal(requests[0].conversationId, undefined);

    await runAntigravity(runtime, service.finishTurn);
    const second = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "follow-up",
        historyBootstrap: "MUST NOT BE REPEATED",
        modelId: "gemini-3.7-flash",
        effort: "medium",
      }),
    );
    assert.equal(await second.next(), null);
    assert.equal(requests[1].prompt, "follow-up");
    assert.equal(requests[1].conversationId, "conversation-1");

    await runAntigravity(runtime, service.finishTurn);
    const switched = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "after model switch",
        historyBootstrap: "RESTORED AFTER SWITCH",
        modelId: "claude-sonnet-4-6",
        effort: "high",
      }),
    );
    assert.equal(await switched.next(), null);
    assert.equal(requests[2].prompt, "RESTORED AFTER SWITCH\n\nafter model switch");
    assert.equal(requests[2].conversationId, undefined);
  } finally {
    await runtime.dispose();
  }
});

test("runtime reset aborts the active process and clears conversation state", async () => {
  let captured: AgyTurnRequest | undefined;
  const runtime = createAntigravityRuntime(
    (request) =>
      new Promise<AgyTurnOutcome>((resolve) => {
        captured = request;
        request.onConversation?.("live-conversation");
        request.signal?.addEventListener(
          "abort",
          () => resolve({ ...completedOutcome("live-conversation"), status: "ERROR" }),
          { once: true },
        );
      }),
  );
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined));
    await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "long turn",
        modelId: "gemini-3.7-flash",
        effort: "low",
      }),
    );
    assert.equal(captured?.signal?.aborted, false);

    await runAntigravity(runtime, service.reset);
    assert.equal(captured?.signal?.aborted, true);
    assert.deepEqual(await runAntigravity(runtime, service.snapshot), {
      conversationId: undefined,
      model: "gemini-3.7-flash",
      cwd: "/repo",
      turns: 0,
    });
  } finally {
    await runtime.dispose();
  }
});
