import assert from "node:assert/strict";
import { test } from "node:test";
import { AgySpawnError, AgyStallError, type AgyTurnRequest } from "../lib/agy-client.ts";
import { stallContinuationPrompt } from "../lib/prompt.ts";
import { newTurnOutcome, type AgyTurnOutcome } from "../lib/reducer.ts";
import type { AgyTurnExecutor } from "../lib/agy-driver.ts";
import { AntigravityRuntime, createAntigravityRuntime, runAntigravity } from "../src/runtime.ts";

function completedOutcome(conversationId: string): AgyTurnOutcome {
  return {
    ...newTurnOutcome(),
    conversationId,
    status: "OK",
    finished: true,
  };
}

test("runtime owns and recycles its executor on reset, restore, and shutdown", async () => {
  const closes: string[] = [];
  const executor: AgyTurnExecutor = {
    run: async (request) => {
      request.onConversation?.("owned-conversation");
      return completedOutcome("owned-conversation");
    },
    snapshot: () => ({ mode: "persistent", state: "ready", pid: 123, lifecycle: [] }),
    close: async (reason, cause) => {
      closes.push(`${reason}:${cause ?? "none"}`);
    },
  };
  const runtime = createAntigravityRuntime(executor);
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined));
    closes.length = 0;
    const turn = await runAntigravity(
      runtime,
      service.beginStreamTurn({ prompt: "one", modelId: "gemini-3.7-flash" }),
    );
    assert.equal(await turn.next(), null);
    await runAntigravity(runtime, service.finishTurn);
    await runAntigravity(runtime, service.reset);
    assert.deepEqual(closes, ["recycle:reset"]);

    await runAntigravity(
      runtime,
      service.restoreConversation({
        conversationId: "restored",
        modelId: "gemini-3.7-flash",
        cwd: "/repo",
        turns: 1,
        usage: {},
      }),
    );
    assert.deepEqual(closes, ["recycle:reset", "recycle:restore"]);
    await runAntigravity(runtime, service.close);
    assert.deepEqual(closes, ["recycle:reset", "recycle:restore", "shutdown:none"]);
  } finally {
    await runtime.dispose();
  }
});

test("runtime re-entry keeps the active driver turn despite a newer bridge revision", async () => {
  let runs = 0;
  const closes: string[] = [];
  let resolveRun: ((outcome: AgyTurnOutcome) => void) | undefined;
  const executor: AgyTurnExecutor = {
    run: async () => {
      runs += 1;
      return new Promise<AgyTurnOutcome>((resolve) => {
        resolveRun = resolve;
      });
    },
    snapshot: () => ({ mode: "persistent", state: "running", lifecycle: [] }),
    close: async (reason) => {
      closes.push(reason);
    },
  };
  const runtime = createAntigravityRuntime(executor);
  const service = runtime.runSync(AntigravityRuntime);
  try {
    const first = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "same user turn",
        modelId: "gemini-3.7-flash",
        bridgeRevision: "1:1",
      }),
    );
    const reentered = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "same user turn",
        modelId: "gemini-3.7-flash",
        bridgeRevision: "1:2",
      }),
    );
    assert.equal(reentered, first);
    assert.equal(runs, 1);
    assert.deepEqual(closes, []);

    resolveRun?.(completedOutcome("reentry-conversation"));
    assert.equal(await first.next(), null);
    await runAntigravity(runtime, service.close);
    assert.deepEqual(closes, ["shutdown"]);
  } finally {
    await runtime.dispose();
  }
});

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

test("runtime carries cumulative agy usage into the next resumed turn", async () => {
  let call = 0;
  const runtime = createAntigravityRuntime(async (request) => {
    call += 1;
    const conversationId = "conversation-usage";
    request.onConversation?.(conversationId);
    return {
      ...completedOutcome(conversationId),
      usage:
        call === 1
          ? { input_tokens: 1_000, output_tokens: 100, total_tokens: 1_100 }
          : { input_tokens: 1_300, output_tokens: 140, total_tokens: 1_440 },
    };
  });
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined));
    const first = await runAntigravity(
      runtime,
      service.beginStreamTurn({ prompt: "first", modelId: "gemini-3.7-flash" }),
    );
    assert.equal(await first.next(), null);
    await runAntigravity(runtime, service.finishTurn);

    const second = await runAntigravity(
      runtime,
      service.beginStreamTurn({ prompt: "second", modelId: "gemini-3.7-flash" }),
    );
    assert.equal(await second.next(), null);
    assert.deepEqual(
      second.claimUsage({ input_tokens: 1_300, output_tokens: 140, total_tokens: 1_440 }, true),
      { input_tokens: 300, output_tokens: 40, total_tokens: 340 },
    );
  } finally {
    await runtime.dispose();
  }
});

test("runtime restores a persisted native conversation and cumulative usage", async () => {
  const requests: AgyTurnRequest[] = [];
  const runtime = createAntigravityRuntime(async (request) => {
    requests.push(request);
    request.onConversation?.("persisted-conversation");
    return {
      ...completedOutcome("persisted-conversation"),
      usage: { input_tokens: 1_250, output_tokens: 125, total_tokens: 1_375 },
    };
  });
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined));
    await runAntigravity(
      runtime,
      service.restoreConversation({
        conversationId: "persisted-conversation",
        modelId: "gemini-3.7-flash",
        cwd: "/repo",
        turns: 7,
        usage: { input_tokens: 1_000, output_tokens: 100, total_tokens: 1_100 },
      }),
    );
    const controller = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "continue",
        historyBootstrap: "PI FALLBACK HISTORY",
        modelId: "gemini-3.7-flash",
      }),
    );
    assert.equal(await controller.next(), null);
    assert.equal(requests[0].conversationId, "persisted-conversation");
    assert.equal(requests[0].prompt, "continue");
    assert.deepEqual(await runAntigravity(runtime, service.snapshot), {
      conversationId: "persisted-conversation",
      model: "gemini-3.7-flash",
      cwd: "/repo",
      turns: 8,
      conversationUsage: { input_tokens: 1_250, output_tokens: 125, total_tokens: 1_375 },
      executor: { mode: "one-shot", state: "idle", lifecycle: [] },
    });
  } finally {
    await runtime.dispose();
  }
});

test("runtime falls back to bounded Pi history when a persisted conversation disappeared", async () => {
  const requests: AgyTurnRequest[] = [];
  const runtime = createAntigravityRuntime(async (request) => {
    requests.push(request);
    if (requests.length === 1) {
      throw new AgySpawnError("conversation persisted-conversation not found", "");
    }
    request.onConversation?.("replacement-conversation");
    return completedOutcome("replacement-conversation");
  });
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined));
    await runAntigravity(
      runtime,
      service.restoreConversation({
        conversationId: "persisted-conversation",
        modelId: "gemini-3.7-flash",
        cwd: "/repo",
        turns: 7,
        usage: { total_tokens: 10_000 },
      }),
    );
    const controller = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "continue",
        historyBootstrap: "PI FALLBACK HISTORY",
        bootstrapSuffix: "SKILL CATALOG",
        modelId: "gemini-3.7-flash",
      }),
    );
    assert.deepEqual(await controller.next(), { type: "conversation_fallback" });
    assert.equal(await controller.next(), null);
    assert.equal(requests[0].conversationId, "persisted-conversation");
    assert.equal(requests[1].conversationId, undefined);
    assert.equal(requests[1].prompt, "PI FALLBACK HISTORY\n\ncontinue\n\nSKILL CATALOG");
  } finally {
    await runtime.dispose();
  }
});

test("runtime suppresses a missing-conversation result before fresh fallback", async () => {
  let call = 0;
  const runtime = createAntigravityRuntime(async (request) => {
    call += 1;
    if (call === 1) {
      const failure: AgyTurnOutcome = {
        ...completedOutcome("persisted-conversation"),
        status: "ERROR",
        error: "conversation persisted-conversation does not exist",
      };
      request.onActivity?.({
        type: "result",
        status: "ERROR",
        response: "",
        error: failure.error,
        usage: undefined,
      });
      return failure;
    }
    request.onConversation?.("replacement-conversation");
    return completedOutcome("replacement-conversation");
  });
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined));
    await runAntigravity(
      runtime,
      service.restoreConversation({
        conversationId: "persisted-conversation",
        modelId: "gemini-3.7-flash",
        cwd: "/repo",
        turns: 1,
        usage: {},
      }),
    );
    const controller = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "continue",
        historyBootstrap: "PI FALLBACK HISTORY",
        modelId: "gemini-3.7-flash",
      }),
    );
    assert.deepEqual(await controller.next(), { type: "conversation_fallback" });
    assert.equal(await controller.next(), null);
    assert.equal(call, 2);
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
      conversationUsage: {},
      executor: { mode: "one-shot", state: "idle", lifecycle: [] },
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

test("runtime stall retry preserves original prompt on pre-init stall without conversation id", async (t) => {
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
      // Stalls before emitting any init/conversationId.
      throw new AgyStallError(120_000, false);
    }
    request.onConversation?.("c-recovered");
    return completedOutcome("c-recovered");
  });
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined));
    const controller = await runAntigravity(
      runtime,
      service.beginStreamTurn({ prompt: "original task", modelId: "gemini-3.7-flash" }),
    );
    const stall = await controller.next();
    assert.equal(stall?.type, "stall");
    assert.equal(await controller.next(), null);

    assert.equal(requests.length, 2);
    // Because no conversation id was established, the retry re-sends the ORIGINAL task,
    // not a continuation-only prompt on a blank conversation.
    assert.equal(requests[1]?.prompt, "original task");
    assert.equal(requests[1]?.conversationId, undefined);
  } finally {
    await runtime.dispose();
  }
});

test("runtime injects bootstrapSuffix when direct skill fallback occurs mid-conversation", async () => {
  const requests: AgyTurnRequest[] = [];
  const runtime = createAntigravityRuntime(async (request) => {
    requests.push(request);
    const conversationId = "conv-mid-fallback";
    request.onConversation?.(conversationId);
    return completedOutcome(conversationId);
  });
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined, true));
    // Turn 1: Bridge was active, so bootstrapSuffix is undefined.
    const turn1 = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "turn 1 with bridge",
        bootstrapSuffix: undefined,
        modelId: "gemini-3.7-flash",
      }),
    );
    assert.equal(await turn1.next(), null);
    assert.equal(requests[0].prompt, "turn 1 with bridge");
    assert.equal(requests[0].conversationId, undefined);

    await runAntigravity(runtime, service.finishTurn);

    // Turn 2: Bridge re-registration fails; direct-skill fallback provides bootstrapSuffix.
    const turn2 = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "turn 2 with direct skills",
        bootstrapSuffix: "SKILL CATALOG FALLBACK",
        modelId: "gemini-3.7-flash",
      }),
    );
    assert.equal(await turn2.next(), null);
    // Even though conversationId already exists, the suffix must be injected
    // because this conversation never received direct skills before.
    assert.equal(requests[1].prompt, "turn 2 with direct skills\n\nSKILL CATALOG FALLBACK");
    assert.equal(requests[1].conversationId, "conv-mid-fallback");

    await runAntigravity(runtime, service.finishTurn);

    // Turn 3: Suffix was already bootstrapped into this conversation; not repeated.
    const turn3 = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "turn 3 unchanged skills",
        bootstrapSuffix: "SKILL CATALOG FALLBACK",
        modelId: "gemini-3.7-flash",
      }),
    );
    assert.equal(await turn3.next(), null);
    assert.equal(requests[2].prompt, "turn 3 unchanged skills");
    assert.equal(requests[2].conversationId, "conv-mid-fallback");
  } finally {
    await runtime.dispose();
  }
});

test("runtime preserves bootstrapSuffix when first attempt fails non-stall before conversation init", async () => {
  const requests: AgyTurnRequest[] = [];
  let call = 0;
  const runtime = createAntigravityRuntime(async (request) => {
    requests.push(request);
    call++;
    if (call === 1) {
      // First attempt fails immediately (e.g. auth error, binary not found) before init
      throw new Error("failed to start agy: binary not found");
    }
    const conversationId = "conv-after-auth-fix";
    request.onConversation?.(conversationId);
    return completedOutcome(conversationId);
  });
  const service = runtime.runSync(AntigravityRuntime);
  try {
    await runAntigravity(runtime, service.setSession("/repo", undefined, true));

    // Turn 1: Fails with non-stall error
    const turn1 = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "first prompt",
        bootstrapSuffix: "SKILL CATALOG",
        modelId: "gemini-3.7-flash",
      }),
    );
    await assert.rejects(() => turn1.next(), /binary not found/);
    assert.equal(requests[0].prompt, "first prompt\n\nSKILL CATALOG");

    await runAntigravity(runtime, service.finishTurn);

    // Turn 2: User retries after fixing environment; skills must NOT be lost!
    const turn2 = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "retry prompt",
        bootstrapSuffix: "SKILL CATALOG",
        modelId: "gemini-3.7-flash",
      }),
    );
    assert.equal(await turn2.next(), null);
    // Crucial: bootstrapSuffix is STILL included because turn 1 failed before conversation init
    assert.equal(requests[1].prompt, "retry prompt\n\nSKILL CATALOG");
    assert.equal(requests[1].conversationId, undefined);

    await runAntigravity(runtime, service.finishTurn);

    // Turn 3: Conversation is now established and received skills; suffix is now suppressed
    const turn3 = await runAntigravity(
      runtime,
      service.beginStreamTurn({
        prompt: "follow up",
        bootstrapSuffix: "SKILL CATALOG",
        modelId: "gemini-3.7-flash",
      }),
    );
    assert.equal(await turn3.next(), null);
    assert.equal(requests[2].prompt, "follow up");
    assert.equal(requests[2].conversationId, "conv-after-auth-fix");
  } finally {
    await runtime.dispose();
  }
});
