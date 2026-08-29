import assert from "node:assert/strict";
import { test } from "node:test";
import { AgyStallError, type AgyTurnRequest } from "../lib/agy-client.ts";
import { stallContinuationPrompt } from "../lib/prompt.ts";
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
      }),
    );
    assert.equal(await first.next(), null);
    assert.equal(requests[0].prompt, "RESTORED PI BRANCH\n\ncurrent request\n\nSKILL CATALOG");
    assert.equal(requests[0].conversationId, undefined);
    assert.equal(requests[0].effort, undefined);

    await runAntigravity(runtime, service.finishTurn);
    const second = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "follow-up",
        historyBootstrap: "MUST NOT BE REPEATED",
        // Direct-mode extras still come from the provider every request; the
        // runtime must keep them off conversation resumes.
        bootstrapSuffix: "SKILL CATALOG",
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
        bootstrapSuffix: "SKILL CATALOG",
        modelId: "claude-sonnet-4-6",
        effort: "high",
      }),
    );
    assert.equal(await switched.next(), null);
    // Model switch starts a fresh conversation — extras ride again.
    assert.equal(
      requests[2].prompt,
      "RESTORED AFTER SWITCH\n\nafter model switch\n\nSKILL CATALOG",
    );
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

test("runtime retries a stalled turn by resuming the conversation", async (t) => {
  process.env.AGY_STALL_RETRY_BACKOFF_MS = "1";
  t.after(() => {
    delete process.env.AGY_STALL_RETRY_BACKOFF_MS;
  });
  const requests: AgyTurnRequest[] = [];
  let call = 0;
  const runtime = createAntigravityRuntime(async (request) => {
    requests.push(request);
    call += 1;
    if (call === 1) {
      // The stalled attempt still reveals the conversation id.
      request.onConversation?.("c-stall");
      throw new AgyStallError(120_000, false);
    }
    return completedOutcome("c-stall");
  });
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined));
    const controller = await runAntigravity(
      runtime,
      service.beginStreamTurn({ prompt: "slow turn", modelId: "gemini-3.7-flash" }),
    );
    const stall = await controller.next();
    assert.equal(stall?.type, "stall");
    assert.deepEqual(stall, {
      type: "stall",
      retry: 1,
      maxRetries: 2,
      stalledMs: 120_000,
      toolActive: false,
    });
    assert.equal(await controller.next(), null);

    // Exactly two attempts; the retry resumes the conversation with the
    // continuation prompt instead of re-sending pi history.
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.conversationId, "c-stall");
    assert.equal(requests[1]?.prompt, stallContinuationPrompt());
  } finally {
    await runtime.dispose();
  }
});

test("runtime aborts a stalled retry during backoff without starting another attempt", async (t) => {
  process.env.AGY_STALL_RETRY_BACKOFF_MS = "50";
  t.after(() => {
    delete process.env.AGY_STALL_RETRY_BACKOFF_MS;
  });
  const abort = new AbortController();
  const requests: AgyTurnRequest[] = [];
  const runtime = createAntigravityRuntime(async (request) => {
    requests.push(request);
    request.onConversation?.("c-stall");
    throw new AgyStallError(120_000, false);
  });
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined));
    const turn = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "cancelled turn",
        modelId: "gemini-3.7-flash",
        signal: abort.signal,
      }),
    );
    assert.equal((await turn.next())?.type, "stall");
    abort.abort();
    await assert.rejects(() => turn.next(), /agy turn was aborted/);
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    assert.equal(requests.length, 1);
  } finally {
    await runtime.dispose();
  }
});

test("runtime fails the turn after exhausting stall retries", async (t) => {
  process.env.AGY_STALL_RETRY_BACKOFF_MS = "1";
  t.after(() => {
    delete process.env.AGY_STALL_RETRY_BACKOFF_MS;
  });
  const requests: AgyTurnRequest[] = [];
  const runtime = createAntigravityRuntime(async (request) => {
    requests.push(request);
    throw new AgyStallError(120_000, true);
  });
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined));
    const controller = await runAntigravity(
      runtime,
      service.beginStreamTurn({ prompt: "doomed turn", modelId: "gemini-3.7-flash" }),
    );
    assert.equal((await controller.next())?.type, "stall");
    const second = await controller.next();
    assert.equal(second?.type, "stall");
    assert.equal((second as { retry?: number }).retry, 2);
    await assert.rejects(() => controller.next(), /agy stream stalled/);
    assert.equal(requests.length, 3);
  } finally {
    await runtime.dispose();
  }
});

test("runtime does not retry non-stall failures", async () => {
  const requests: AgyTurnRequest[] = [];
  const runtime = createAntigravityRuntime(async (request) => {
    requests.push(request);
    throw new Error("agy exited with code 1 before producing a result");
  });
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined));
    const controller = await runAntigravity(
      runtime,
      service.beginStreamTurn({ prompt: "broken agy", modelId: "gemini-3.7-flash" }),
    );
    await assert.rejects(() => controller.next(), /exited with code 1/);
    assert.equal(requests.length, 1);
  } finally {
    await runtime.dispose();
  }
});
