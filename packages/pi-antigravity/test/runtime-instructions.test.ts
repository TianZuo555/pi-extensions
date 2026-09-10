import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { AgySpawnError, AgyStallError, type AgyTurnRequest } from "../lib/agy-client.ts";
import { piSystemInstructionsPrompt, stallContinuationPrompt } from "../lib/prompt.ts";
import { newTurnOutcome } from "../lib/reducer.ts";
import {
  AntigravityRuntime,
  createAntigravityRuntime,
  type AgyTurnRunner,
  type AntigravityRuntimeShape,
} from "../src/runtime.ts";

type TurnRequest = Parameters<AntigravityRuntimeShape["beginStreamTurn"]>[0];
const outcome = (conversationId = "native") => ({
  ...newTurnOutcome(),
  conversationId,
  status: "OK" as const,
  finished: true,
});

function setup(t: TestContext, runner?: AgyTurnRunner) {
  const requests: AgyTurnRequest[] = [];
  const runtime = createAntigravityRuntime(async (request) => {
    requests.push(request);
    if (runner) return runner(request);
    request.onConversation?.("native");
    return outcome();
  });
  const service = runtime.runSync(AntigravityRuntime);
  t.after(async () => {
    await runtime.runPromise(service.close);
    await runtime.dispose();
  });
  const begin = (request: Omit<TurnRequest, "modelId">) =>
    runtime.runPromise(service.beginStreamTurn({ ...request, modelId: "fixture" }));
  const complete = async (request: Omit<TurnRequest, "modelId">) => {
    const controller = await begin(request);
    while (await controller.next()) {
      /* Drain synthetic activities. */
    }
    await runtime.runPromise(service.finishTurn);
  };
  return { runtime, service, requests, begin, complete };
}

function env(t: TestContext, name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("first agy turn restores other-provider history after /new; explicit reset does not", async (t) => {
  const f = setup(t);
  await f.runtime.runPromise(f.service.setSession("/repo", undefined, false));
  await f.complete({ prompt: "implement it", historyBootstrap: "agreed plan" });
  assert.equal(f.requests[0].prompt, "agreed plan\n\nimplement it");
  await f.runtime.runPromise(f.service.reset);
  await f.complete({
    prompt: "new task",
    historyBootstrap: "agreed plan",
    systemPrompt: "project rules",
  });
  assert.doesNotMatch(f.requests[1].prompt, /agreed plan/);
  assert.match(f.requests[1].prompt, /project rules/);
});

test("failed pre-init send does not consume pending history or instructions", async (t) => {
  let attempts = 0;
  const f = setup(t, async (request) => {
    if (++attempts === 1) throw new AgySpawnError("preflight failed", "");
    request.onConversation?.("native");
    return outcome();
  });
  const first = await f.begin({
    prompt: "first",
    historyBootstrap: "history",
    systemPrompt: "rules",
  });
  await assert.rejects(first.next(), /preflight failed/);
  await f.complete({ prompt: "retry", historyBootstrap: "history", systemPrompt: "rules" });
  assert.match(f.requests[1].prompt, /history\n\nretry/);
  assert.match(f.requests[1].prompt, /rules/);
});

test("instructions synchronize once, update, clear, and resend after reset", async (t) => {
  const f = setup(t);
  await f.complete({ prompt: "one", systemPrompt: "rules A" });
  assert.equal(f.requests[0].prompt, `${piSystemInstructionsPrompt("rules A")}\n\none`);
  await f.complete({ prompt: "two", systemPrompt: "rules A" });
  assert.equal(f.requests[1].prompt, "two");
  await f.complete({ prompt: "three", systemPrompt: "rules B" });
  assert.equal(f.requests[2].prompt, `${piSystemInstructionsPrompt("rules B")}\n\nthree`);
  await f.complete({ prompt: "four" });
  assert.equal(f.requests[3].prompt, `${piSystemInstructionsPrompt("")}\n\nfour`);
  await f.complete({ prompt: "five" });
  assert.equal(f.requests[4].prompt, "five");
  await f.runtime.runPromise(f.service.reset);
  await f.complete({ prompt: "six", systemPrompt: "rules B" });
  assert.equal(f.requests[5].prompt, `${piSystemInstructionsPrompt("rules B")}\n\nsix`);
});

test("tool re-entry defers changed instructions until the next user turn", async (t) => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = setup(t, async (request) => {
    request.onConversation?.("native");
    await gate;
    return outcome();
  });
  const first = await f.begin({ prompt: "same", systemPrompt: "rules A" });
  const reentry = await f.begin({ prompt: "same", systemPrompt: "rules B" });
  assert.equal(first, reentry);
  assert.equal(f.requests.length, 1);
  finish();
  assert.equal(await first.next(), null);
  await f.complete({ prompt: "next", systemPrompt: "rules B" });
  assert.match(f.requests[1].prompt, /rules B/);
});

test("restored native conversations resync instructions and fresh fallback receives them too", async (t) => {
  let attempts = 0;
  const f = setup(t, async (request) => {
    if (++attempts === 2) throw new AgySpawnError("conversation missing", "");
    request.onConversation?.("native");
    return outcome();
  });
  await f.complete({ prompt: "initial", systemPrompt: "same rules" });
  await f.runtime.runPromise(
    f.service.restoreConversation({
      conversationId: "stale",
      modelId: "fixture",
      cwd: "/repo",
      turns: 1,
      usage: {},
    }),
  );
  await f.complete({
    prompt: "continue",
    systemPrompt: "same rules",
    historyBootstrap: "branch history",
  });
  assert.match(f.requests[1].prompt, /same rules/);
  assert.equal(f.requests[1].conversationId, "stale");
  assert.equal(f.requests[2].conversationId, undefined);
  assert.equal(
    f.requests[2].prompt,
    `${piSystemInstructionsPrompt("same rules")}\n\nbranch history\n\ncontinue`,
  );
});

for (const systemPrompt of ["updated instructions", ""]) {
  test(`resume retry retains unacknowledged ${systemPrompt ? "updated" : "cleared"} instructions and skills`, async (t) => {
    env(t, "AGY_STALL_RETRY_BACKOFF_MS", "0");
    let attempts = 0;
    const f = setup(t, async (request) => {
      if (++attempts === 2) throw new AgyStallError(1, false);
      // A terminal result without onConversation must also commit what it sent.
      if (attempts === 1) request.onConversation?.("native");
      return outcome();
    });
    await f.complete({
      prompt: "initial",
      systemPrompt: "old instructions",
      bootstrapSuffix: "old skills",
    });
    await f.complete({ prompt: "update", systemPrompt, bootstrapSuffix: "new skills" });
    assert.equal(f.requests[2].conversationId, "native");
    assert.equal(
      f.requests[2].prompt,
      [piSystemInstructionsPrompt(systemPrompt), stallContinuationPrompt(), "new skills"].join(
        "\n\n",
      ),
    );
    await f.complete({ prompt: "next", systemPrompt, bootstrapSuffix: "new skills" });
    assert.equal(f.requests[3].prompt, "next");
  });
}

test("acknowledged instructions and skills are not duplicated on a stall retry", async (t) => {
  env(t, "AGY_STALL_RETRY_BACKOFF_MS", "0");
  let attempts = 0;
  const f = setup(t, async (request) => {
    request.onConversation?.("native");
    if (++attempts === 2) throw new AgyStallError(1, false);
    return outcome();
  });
  await f.complete({ prompt: "initial", systemPrompt: "old" });
  await f.complete({ prompt: "update", systemPrompt: "new", bootstrapSuffix: "skills" });
  assert.equal(f.requests[2].prompt, stallContinuationPrompt());
  await f.complete({ prompt: "next", systemPrompt: "new", bootstrapSuffix: "skills" });
  assert.equal(f.requests[3].prompt, "next");
});

test("an unacknowledged error result does not commit an instruction or skills update", async (t) => {
  let attempts = 0;
  const f = setup(t, async (request) => {
    if (++attempts === 2) return { ...outcome(), status: "ERROR", error: "request rejected" };
    request.onConversation?.("native");
    return outcome();
  });
  await f.complete({ prompt: "initial", systemPrompt: "old", bootstrapSuffix: "old skills" });
  await f.complete({ prompt: "rejected", systemPrompt: "new", bootstrapSuffix: "new skills" });
  await f.complete({ prompt: "next", systemPrompt: "new", bootstrapSuffix: "new skills" });
  assert.equal(
    f.requests[2].prompt,
    [piSystemInstructionsPrompt("new"), "next", "new skills"].join("\n\n"),
  );
});

test("fresh fallback retries keep all context and never resurrect a missing conversation ID", async (t) => {
  env(t, "AGY_STALL_RETRY_BACKOFF_MS", "0");
  let attempts = 0;
  const f = setup(t, async (request) => {
    if (++attempts === 1) {
      // An init from the missing conversation must not commit sync for its replacement.
      request.onConversation?.("missing");
      throw new AgySpawnError("conversation missing", "");
    }
    if (attempts === 2) throw new AgyStallError(1, false);
    request.onConversation?.("fresh");
    return outcome("fresh");
  });
  await f.runtime.runPromise(
    f.service.restoreConversation({
      conversationId: "missing",
      modelId: "fixture",
      cwd: "/repo",
      turns: 0,
      usage: {},
    }),
  );
  await f.complete({
    prompt: "continue",
    systemPrompt: "rules",
    bootstrapSuffix: "skills",
    historyBootstrap: "history",
  });
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[0].conversationId, "missing");
  for (const request of f.requests.slice(1)) {
    assert.equal(request.conversationId, undefined);
    assert.equal(
      request.prompt,
      [piSystemInstructionsPrompt("rules"), "history", "continue", "skills"].join("\n\n"),
    );
  }
  await f.complete({ prompt: "next", systemPrompt: "rules", bootstrapSuffix: "skills" });
  assert.equal(f.requests[3].prompt, "next");
});

test("logical deadline interrupts retry backoff without submitting another attempt", async (t) => {
  env(t, "AGY_TURN_TIMEOUT_MS", "100");
  env(t, "AGY_STALL_RETRY_BACKOFF_MS", "1000");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const f = setup(t, async () => {
    throw new AgyStallError(10, false);
  });
  const turn = await f.begin({ prompt: "slow" });
  assert.equal((await turn.next())?.type, "stall");
  const failed = assert.rejects(turn.next(), /logical turn timed out/);
  t.mock.timers.tick(100);
  await failed;
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].signal?.aborted, true);
});

test("retries receive only the remaining logical-turn budget", async (t) => {
  env(t, "AGY_TURN_TIMEOUT_MS", "100");
  env(t, "AGY_STALL_RETRY_BACKOFF_MS", "10");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let attempts = 0;
  const f = setup(t, async () => {
    if (++attempts === 1) {
      t.mock.timers.tick(40);
      throw new AgyStallError(40, false);
    }
    return outcome();
  });
  const turn = await f.begin({ prompt: "retry" });
  assert.equal((await turn.next())?.type, "stall");
  t.mock.timers.tick(10);
  assert.equal(await turn.next(), null);
  assert.equal(f.requests[0].timeoutMs, 100);
  assert.equal(f.requests[1].timeoutMs, 50);
});

test("a delayed stale-resume result cannot reset a newer conversation after cancellation", async (t) => {
  env(t, "AGY_TURN_TIMEOUT_MS", "100");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let attempts = 0;
  const f = setup(t, async (request) => {
    if (++attempts === 1) {
      request.onActivity?.({
        type: "result",
        status: "ERROR",
        response: "",
        error: "conversation missing",
        usage: undefined,
      });
      await gate;
      return outcome("stale");
    }
    request.onConversation?.("current");
    return outcome("current");
  });
  await f.runtime.runPromise(
    f.service.restoreConversation({
      conversationId: "stale",
      modelId: "fixture",
      cwd: "/repo",
      turns: 0,
      usage: {},
    }),
  );
  const old = await f.begin({ prompt: "old" });
  const failed = assert.rejects(old.next(), /logical turn timed out/);
  t.mock.timers.tick(100);
  await failed;
  await f.complete({ prompt: "new" });
  finish();
  await setImmediate();
  assert.equal((await f.runtime.runPromise(f.service.snapshot)).conversationId, "current");
  assert.equal(f.requests.length, 2);
});

test("a cancelled race handles a non-cooperative executor's later rejection", async (t) => {
  env(t, "AGY_TURN_TIMEOUT_MS", "100");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let rejectLate!: (error: Error) => void;
  const gate = new Promise<never>((_resolve, reject) => {
    rejectLate = reject;
  });
  const f = setup(t, () => gate);
  const turn = await f.begin({ prompt: "late rejection" });
  const failed = assert.rejects(turn.next(), /logical turn timed out/);
  t.mock.timers.tick(100);
  await failed;
  rejectLate(new Error("late executor failure"));
  // node --test treats any unhandled rejection as a failure, even after a test ends.
  await setImmediate();
  await setImmediate();
  assert.equal(turn.isClosed(), true);
});

test("deadline bounds non-cooperative startup and fences late native callbacks", async (t) => {
  env(t, "AGY_TURN_TIMEOUT_MS", "100");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = setup(t, async (request) => {
    await gate;
    request.onConversation?.("late");
    request.onActivity?.({ type: "text", delta: "late response" });
    return outcome("late");
  });
  const turn = await f.begin({ prompt: "blocked preflight" });
  const failed = assert.rejects(turn.next(), /logical turn timed out/);
  t.mock.timers.tick(100);
  await failed;
  finish();
  await setImmediate();
  assert.equal(turn.hasPending(), false);
  const snapshot = await f.runtime.runPromise(f.service.snapshot);
  assert.equal(snapshot.conversationId, undefined);
  assert.equal(snapshot.turns, 0);
  assert.equal(getEventListeners(f.requests[0].signal!, "abort").length, 0);
});

test("relayed instructions omit Pi's tool inventory but keep all other guidance", () => {
  // Shape of Pi's real system prompt (see the captured relay in
  // ~/.pi/agent/antigravity/debug/). agy cannot call any Pi builtin:
  // selectBridgedTools bridges MCP-adapter tools only.
  const instructions = [
    "You are an expert coding assistant operating inside pi.",
    "",
    "Available tools:",
    "- read: Read file contents",
    "- bash: Run Bash; long commands yield and notify on exit",
    "- web_fetch: Fetch a web page",
    "",
    "In addition to the tools above, you may have access to other custom tools.",
    "",
    "Guidelines:",
    "- Be concise in your responses",
    "",
    "<project_instructions path=\"/repo/AGENTS.md\">",
    "## Coding Principles",
    "- Do not preserve backward compatibility.",
    "</project_instructions>",
  ].join("\n");

  const relayed = piSystemInstructionsPrompt(instructions);

  // The inventory block and its trailing caveat are gone.
  assert.doesNotMatch(relayed, /Available tools:/);
  assert.doesNotMatch(relayed, /- read: Read file contents/);
  assert.doesNotMatch(relayed, /- bash: Run Bash/);
  assert.doesNotMatch(relayed, /- web_fetch: Fetch a web page/);
  assert.doesNotMatch(relayed, /In addition to the tools above/);

  // Everything else survives verbatim, including project guidance.
  assert.match(relayed, /expert coding assistant/);
  assert.match(relayed, /Guidelines:/);
  assert.match(relayed, /- Be concise in your responses/);
  assert.match(relayed, /## Coding Principles/);
  assert.match(relayed, /Do not preserve backward compatibility\./);
  assert.match(relayed, /project_instructions path="\/repo\/AGENTS\.md"/);
  // The framing still tells agy the relayed tool guidance is not its own.
  assert.match(relayed, /cannot call it/);
  assert.match(relayed, /## End of Pi instructions/);
});

test("an instruction snapshot that is only Pi's tool inventory relays as empty", () => {
  // The full validated block (bullets plus the closing caveat) is Pi's own, so
  // stripping it can legitimately leave nothing to relay.
  const relayed = piSystemInstructionsPrompt(
    [
      "Available tools:",
      "- read: Read file contents",
      "",
      "In addition to the tools above, you may have access to other custom tools.",
    ].join("\n"),
  );
  assert.match(relayed, /instruction snapshot is now empty/);
});

test("an inventory missing Pi's closing caveat is relayed rather than guessed at", () => {
  // Without the caveat this cannot be confirmed as Pi's block; relaying a few
  // redundant lines is strictly safer than deleting unknown guidance.
  const relayed = piSystemInstructionsPrompt(
    ["Available tools:", "- deploy: ship it", "", "Ask before deploying."].join("\n"),
  );
  assert.match(relayed, /- deploy: ship it/);
  assert.match(relayed, /Ask before deploying\./);
});

test("tool-inventory stripping never touches project instructions", () => {
  // "Available tools:" is ordinary prose that project guidance may use. Losing
  // a user's deployment rules is far worse than relaying redundant lines, so
  // only Pi's validated top-level inventory may be removed.
  const instructions = [
    "You are an expert coding assistant operating inside pi.",
    "",
    "Available tools:",
    "- read: Read file contents",
    "- bash: Run Bash; long commands yield and notify on exit",
    "",
    "In addition to the tools above, you may have access to other custom tools.",
    "",
    '<project_instructions path="/repo/AGENTS.md">',
    "## Deployment",
    "Available tools: terraform, kubectl, helm.",
    "- Never deploy to prod without written approval from the on-call lead.",
    "- Always run `terraform plan` and attach the diff to the ticket.",
    "</project_instructions>",
  ].join("\n");

  const relayed = piSystemInstructionsPrompt(instructions);

  // Pi's own inventory is gone.
  assert.doesNotMatch(relayed, /- read: Read file contents/);
  assert.doesNotMatch(relayed, /In addition to the tools above/);
  // The project's own section, including its "Available tools:" line, survives.
  assert.match(relayed, /Available tools: terraform, kubectl, helm\./);
  assert.match(relayed, /Never deploy to prod without written approval/);
  assert.match(relayed, /Always run `terraform plan`/);
});

test("an unvalidated Available tools block is left untouched", () => {
  // No trailing Pi caveat and no "- name: description" bullets: not Pi's
  // inventory, so the text must relay verbatim.
  const prose = ["Notes for the operator.", "", "Available tools: see the wiki.", "", "Be careful."].join(
    "\n",
  );
  const relayed = piSystemInstructionsPrompt(prose);
  assert.match(relayed, /Available tools: see the wiki\./);
  assert.match(relayed, /Be careful\./);
});
