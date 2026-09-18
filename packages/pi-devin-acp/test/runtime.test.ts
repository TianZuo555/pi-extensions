import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { getEventListeners } from "node:events";
import { streamDevin } from "../src/provider.ts";
import { DevinReplayStore } from "../lib/replay.ts";
import type { AssistantMessage, Context, Model, Api } from "@earendil-works/pi-ai";
import type { DevinModelFamily } from "../lib/models.ts";
import type { DevinAcpClient } from "../lib/acp-client.ts";
import {
  createDevinRuntime,
  DevinRuntime,
  runDevin,
  type DevinRuntimeShape,
} from "../src/runtime.ts";
import type { DevinSessionListener } from "../lib/acp-client.ts";

/**
 * Fake DevinAcpClient: implements the surface the runtime consumes. Pushes
 * canned updates through the registered session listener when prompted.
 */
class FakeClient {
  started = false;
  sessions = new Map<string, DevinSessionListener>();
  createdSessions: string[] = [];
  loaded: string[] = [];
  prompts: { sessionId: string; blocks: ContentBlock[]; clientMessageId?: string }[] = [];
  nextId = 0;
  failLoads = new Set<string>();
  deleted: string[] = [];
  modes: string[] = [];
  cancelled: string[] = [];
  configSets: { configId: string; value: string }[] = [];
  onClose: (() => void) | undefined;
  customHandler: ((method: string, params: unknown) => void) | undefined;

  async ensureStarted() {
    this.started = true;
  }
  setSessionListener(id: string, fn: DevinSessionListener | undefined) {
    if (fn) this.sessions.set(id, fn);
    else this.sessions.delete(id);
  }
  setCustomNotificationHandler(fn?: (method: string, params: unknown) => void) {
    this.customHandler = fn;
  }
  setPermissionHandler() {}
  setOnClose(fn: (() => void) | undefined) {
    this.onClose = fn;
  }
  async newSession(_cwd: string) {
    const id = `sess-${++this.nextId}`;
    this.createdSessions.push(id);
    return { sessionId: id, modes: { currentModeId: "accept-edits" } };
  }
  async loadSession(id: string) {
    this.loaded.push(id);
    if (this.failLoads.has(id)) throw new Error("Session not found");
    return { sessionId: id };
  }
  async prompt(sessionId: string, blocks: ContentBlock[], opts?: { clientMessageId?: string }) {
    this.prompts.push({ sessionId, blocks, clientMessageId: opts?.clientMessageId });
    const listener = this.sessions.get(sessionId);
    listener?.({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "answer" },
    } as never);
    return { stopReason: "end_turn" };
  }
  async cancel(id: string) {
    this.cancelled.push(id);
  }
  async setMode(_id: string, modeId: string) {
    this.modes.push(modeId);
  }
  async setConfigOption(_id: string, configId: string, value: string) {
    this.configSets.push({ configId, value });
    return [];
  }
  async listSessions() {
    return [];
  }
  async deleteSession(id: string) {
    this.deleted.push(id);
  }
  async authenticate() {}
  closeCount = 0;
  async close() {
    this.closeCount += 1;
    // The real client fires onClose when its connection closes.
    this.onClose?.();
  }
}

const TURN = (over: Partial<Parameters<DevinRuntimeShape["beginStreamTurn"]>[0]> = {}) => ({
  prompt: "hi",
  blocks: [{ type: "text" as const, text: "hi" }],
  modelId: "swe-2",
  concreteModelId: "swe-2-medium",
  cwd: "/tmp/proj",
  ...over,
});

async function makeRuntime() {
  const fake = new FakeClient();
  const runtime = createDevinRuntime(() => fake as unknown as DevinAcpClient);
  const service = runtime.runSync(DevinRuntime);
  return { fake, runtime, service };
}

test("beginStreamTurn creates a session, syncs model, and streams a result", async () => {
  const { fake, runtime, service } = await makeRuntime();
  const controller = await runDevin(runtime, service.beginStreamTurn(TURN()));
  assert.equal(fake.createdSessions.length, 1);
  assert.deepEqual(fake.configSets, [{ configId: "model", value: "swe-2-medium" }]);
  const activities = [];
  for (;;) {
    const a = await controller.next();
    if (a === null) break;
    activities.push(a);
  }
  assert.ok(activities.some((a) => a.type === "text" && a.delta === "answer"));
  assert.equal(activities.at(-1)?.type, "result");
  const snapshot = await runDevin(runtime, service.snapshot);
  assert.equal(snapshot.sessionId, "sess-1");
  assert.equal(snapshot.turns, 1);
  await runtime.dispose();
});

test("re-attach returns the same controller for the same prompt", async () => {
  const { fake, runtime, service } = await makeRuntime();
  // Turn whose prompt never resolves: re-attach must not re-prompt.
  fake.prompt = async (sessionId: string, blocks: ContentBlock[]) => {
    fake.prompts.push({ sessionId, blocks });
    return new Promise(() => {});
  };
  const first = await runDevin(runtime, service.beginStreamTurn(TURN()));
  const again = await runDevin(runtime, service.beginStreamTurn(TURN()));
  assert.equal(first, again);
  assert.equal(fake.prompts.length, 1);
  await runtime.dispose();
});

test("suspend kills the client, drops the binding, and stays usable", async () => {
  const { fake, runtime, service } = await makeRuntime();
  const controller = await runDevin(runtime, service.beginStreamTurn(TURN()));
  for (;;) {
    if ((await controller.next()) === null) break;
  }
  assert.equal(fake.createdSessions.length, 1);
  await runDevin(runtime, service.suspend);
  assert.equal(fake.closeCount, 1, "the ACP child is killed");
  const snapshot = await runDevin(runtime, service.snapshot);
  assert.equal(snapshot.sessionId, undefined);
  // The child-exit callback must not resurrect the dropped session: the
  // next turn opens a fresh one instead of lazily loading the old binding.
  const second = await runDevin(runtime, service.beginStreamTurn(TURN()));
  assert.equal(fake.createdSessions.length, 2);
  assert.equal(fake.loaded.length, 0);
  for (;;) {
    if ((await second.next()) === null) break;
  }
  await runtime.dispose();
});

test("closed runtime rejects further use while suspend does not", async () => {
  const { runtime, service } = await makeRuntime();
  await runDevin(runtime, service.suspend);
  const snapshot = await runDevin(runtime, service.snapshot);
  assert.equal(snapshot.sessionId, undefined);
  await runDevin(runtime, service.close);
  await assert.rejects(() => runDevin(runtime, service.snapshot), /shut down/);
  await runtime.dispose();
});

test("failed session/load falls back to a fresh session with bootstrap", async () => {
  const { fake, runtime, service } = await makeRuntime();
  await runDevin(
    runtime,
    service.restoreSession({
      acpSessionId: "old-session",
      cwd: "/tmp/proj",
      modelId: "swe-2",
      turns: 2,
    }),
  );
  fake.failLoads.add("old-session");
  const controller = await runDevin(
    runtime,
    service.beginStreamTurn(TURN({ historyBootstrap: "user:\nprevious question" })),
  );
  assert.equal(fake.createdSessions.length, 1);
  const sent = fake.prompts[0];
  assert.equal(sent.sessionId, "sess-1");
  assert.ok(
    sent.blocks.some((b) => b.type === "resource"),
    "expected bootstrap/resource blocks after fallback",
  );
  for (;;) {
    if ((await controller.next()) === null) break;
  }
  await runtime.dispose();
});

test("runSummaryTurn uses a disposable session and cleans up", async () => {
  const { fake, runtime, service } = await makeRuntime();
  const result = await runDevin(
    runtime,
    service.runSummaryTurn("<conversation>\nx\n</conversation>"),
  );
  assert.equal(result.text, "answer");
  assert.equal(fake.deleted.length, 1);
  const snapshot = await runDevin(runtime, service.snapshot);
  assert.equal(snapshot.sessionId, undefined);
  await runtime.dispose();
});

test("runSummaryTurn syncs the concrete model onto the disposable session", async () => {
  const { fake, runtime, service } = await makeRuntime();
  await runDevin(
    runtime,
    service.runSummaryTurn("<conversation>\nx\n</conversation>", undefined, "swe-2-max"),
  );
  assert.deepEqual(fake.configSets, [{ configId: "model", value: "swe-2-max" }]);
  assert.equal(fake.deleted.length, 1);
  await runtime.dispose();
});

test("cancelled turns do not increment the turn counter", async () => {
  const { fake, runtime, service } = await makeRuntime();
  fake.prompt = async () => ({ stopReason: "cancelled" });
  const controller = await runDevin(runtime, service.beginStreamTurn(TURN()));
  for (;;) {
    if ((await controller.next()) === null) break;
  }
  const snapshot = await runDevin(runtime, service.snapshot);
  assert.equal(snapshot.turns, 0);
  await runtime.dispose();
});

test("rebootstrap turn sends the history resource to the fresh session", async () => {
  const { fake, runtime, service } = await makeRuntime();
  const first = await runDevin(runtime, service.beginStreamTurn(TURN()));
  for (;;) {
    if ((await first.next()) === null) break;
  }
  await runDevin(runtime, service.setSession("/tmp/proj", { rebootstrap: true }));
  const second = await runDevin(
    runtime,
    service.beginStreamTurn(
      TURN({ historyBootstrap: "user:\nprevious question\n\nassistant:\nprior answer" }),
    ),
  );
  assert.equal(fake.createdSessions.length, 2, "fresh session created after reset");
  const sent = fake.prompts.at(-1);
  assert.ok(
    sent?.blocks.some((b) => b.type === "resource"),
    "expected a history bootstrap resource block",
  );
  for (;;) {
    if ((await second.next()) === null) break;
  }
  await runtime.dispose();
});

test("a failed prompt leaves bootstrap and instruction state pending for the retry", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  const first = await runDevin(runtime, service.beginStreamTurn(TURN()));
  for (;;) {
    if ((await first.next()) === null) break;
  }
  // Rebootstrap so the next turn owes history + instruction resources.
  await runDevin(runtime, service.setSession("/tmp/proj", { rebootstrap: true }));

  let calls = 0;
  const flaky = () => {
    calls += 1;
    if (calls === 1) throw new Error("hook exploded");
    return undefined;
  };
  const retryRequest = () =>
    TURN({
      historyBootstrap: "user:\nprevious question",
      systemPrompt: "be terse",
      transformPrompt: flaky,
    });
  await assert.rejects(runDevin(runtime, service.beginStreamTurn(retryRequest())), /hook exploded/);
  assert.equal(fake.prompts.length, 1, "the failed turn never reached devin");

  const retry = await runDevin(runtime, service.beginStreamTurn(retryRequest()));
  for (;;) {
    if ((await retry.next()) === null) break;
  }
  assert.equal(
    fake.prompts.at(-1)?.blocks.filter((b) => b.type === "resource").length,
    2,
    "the retry re-attaches history + instructions",
  );

  // …and only once: a follow-up turn with the same prompt attaches nothing.
  const followUp = await runDevin(
    runtime,
    service.beginStreamTurn(TURN({ systemPrompt: "be terse" })),
  );
  for (;;) {
    if ((await followUp.next()) === null) break;
  }
  assert.equal(fake.prompts.at(-1)?.blocks.filter((b) => b.type === "resource").length, 0);
});

for (const transition of ["rebootstrap", "restore", "suspend", "same-session"] as const) {
  test(`late prompt completion respects binding ownership after ${transition}`, async (t) => {
    const { fake, runtime, service } = await makeRuntime();
    t.after(() => runtime.dispose());
    const pending = deferred<{ stopReason: string }>();
    fake.prompt = async (sessionId, blocks) => {
      fake.prompts.push({ sessionId, blocks });
      return fake.prompts.length === 1 ? pending.promise : { stopReason: "end_turn" };
    };
    const request = TURN({ systemPrompt: "instructions", historyBootstrap: "prior history" });
    await runDevin(runtime, service.setSession(request.cwd, { rebootstrap: true }));
    await runDevin(runtime, service.beginStreamTurn(request));
    if (transition === "rebootstrap") {
      await runDevin(runtime, service.setSession(request.cwd, { rebootstrap: true }));
    } else if (transition === "restore") {
      // Even restoring the same ACP id creates a new binding generation.
      await runDevin(
        runtime,
        service.restoreSession({
          acpSessionId: "sess-1",
          cwd: request.cwd,
          modelId: request.modelId,
          turns: 0,
        }),
      );
    } else if (transition === "suspend") {
      await runDevin(runtime, service.suspend);
    }
    const next = runDevin(
      runtime,
      service.beginStreamTurn({
        ...request,
        prompt: "next",
        blocks: [{ type: "text", text: "next" }],
      }),
    );
    pending.resolve({ stopReason: "cancelled" });
    const controller = await next;
    while (await controller.next()) {}
    const resources = fake.prompts[1].blocks.filter((b) => b.type === "resource");
    assert.equal(
      resources.length,
      transition === "same-session" ? 0 : transition === "restore" ? 1 : 2,
    );
  });
}

test("transport rejection preserves bootstrap resources for retry", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  await runDevin(runtime, service.setSession("/tmp/proj", { rebootstrap: true }));
  fake.prompt = async (sessionId, blocks) => {
    fake.prompts.push({ sessionId, blocks });
    if (fake.prompts.length === 1) throw new Error("transport failed");
    return { stopReason: "end_turn" };
  };
  const request = TURN({ systemPrompt: "instructions", historyBootstrap: "history" });
  const first = await runDevin(runtime, service.beginStreamTurn(request));
  await assert.rejects(first.next(), /transport failed/);
  const retry = await runDevin(runtime, service.beginStreamTurn(request));
  while (await retry.next()) {}
  assert.equal(fake.prompts[1].blocks.filter((b) => b.type === "resource").length, 2);
});

test("a late same-binding completion never overwrites a newer instruction commit", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  // A's prompt stays in flight past the 3s supersede-settle bound, so B is
  // issued and completes while A's prompt request is still unresolved.
  const pendingA = deferred<{ stopReason: string }>();
  let committed: string | undefined;
  fake.prompt = async (sessionId, blocks) => {
    fake.prompts.push({ sessionId, blocks });
    return fake.prompts.length === 1 ? pendingA.promise : { stopReason: "end_turn" };
  };
  const requestFor = (text: string, prompt: string) =>
    TURN({ prompt, systemPrompt: text, historyBootstrap: undefined });
  await runDevin(runtime, service.beginStreamTurn(requestFor("A instructions", "A")));
  const second = await runDevin(
    runtime,
    service.beginStreamTurn(requestFor("B instructions", "B")),
  );
  while (await second.next()) {}
  // A finally answers — after B's newer commit already landed.
  pendingA.resolve({ stopReason: "cancelled" });
  await new Promise((resolve) => setImmediate(resolve));
  // Switching back to A's exact instructions must re-attach them: the latest
  // commit is B's, so lastSentSystemPrompt must never rewind to A.
  const third = await runDevin(runtime, service.beginStreamTurn(requestFor("A instructions", "C")));
  while (await third.next()) {}
  assert.equal(
    fake.prompts[2].blocks.filter((b) => b.type === "resource").length,
    1,
    "B's commit wins; a late A completion must not mark A's snapshot as sent",
  );
  assert.ok(
    !fake.prompts[1].blocks.some(
      (b) =>
        b.type === "resource" &&
        b.resource.mimeType === "text/plain" &&
        "text" in b.resource &&
        String(b.resource.text).includes("A instructions"),
    ),
  );
});

test("liveOps tracks in-flight tools across turns until terminal or exit", async () => {
  const { fake, runtime, service } = await makeRuntime();
  const controller = await runDevin(runtime, service.beginStreamTurn(TURN()));
  const sessionId = fake.createdSessions[0];
  const emit = (update: unknown) => fake.sessions.get(sessionId)?.(update as never);

  // A long-running exec stays listed while in_progress.
  emit({
    sessionUpdate: "tool_call",
    toolCallId: "exec_0",
    title: "Ran sleep",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "sleep 300", timeout: 0 },
  });
  emit({
    sessionUpdate: "tool_call_update",
    toolCallId: "exec_0",
    status: "in_progress",
    _meta: { "cognition.ai/background": true, "cognition.ai/backgroundShellId": "4a8c2f" },
  });
  let snap = await runDevin(runtime, service.snapshot);
  assert.equal(snap.liveOps.length, 1);
  assert.equal(snap.liveOps[0].view.shellId, "4a8c2f");

  // A second op joins; terminal completion drops only that one.
  emit({
    sessionUpdate: "tool_call",
    toolCallId: "read_1",
    title: "Read file",
    kind: "read",
    status: "in_progress",
  });
  snap = await runDevin(runtime, service.snapshot);
  assert.equal(snap.liveOps.length, 2);
  emit({ sessionUpdate: "tool_call_update", toolCallId: "read_1", status: "completed" });
  snap = await runDevin(runtime, service.snapshot);
  assert.equal(snap.liveOps.length, 1);
  assert.equal(snap.liveOps[0].view.id, "exec_0");

  // The turn ends; the backgrounded shell is still tracked between turns.
  for (;;) {
    if ((await controller.next()) === null) break;
  }
  snap = await runDevin(runtime, service.snapshot);
  assert.equal(snap.liveOps.length, 1, "background shell outlives the turn");

  // The shell later exits: terminal_exit clears it even without a terminal
  // status on the tool call itself.
  emit({
    sessionUpdate: "tool_call_update",
    toolCallId: "exec_0",
    status: "in_progress",
    _meta: { "cognition.ai/terminal_exit": { terminal_id: "4a8c2f", exit_code: 0 } },
  });
  snap = await runDevin(runtime, service.snapshot);
  assert.equal(snap.liveOps.length, 0);
  await runtime.dispose();
});

test("reset drops the session binding", async () => {
  const { runtime, service } = await makeRuntime();
  const controller = await runDevin(runtime, service.beginStreamTurn(TURN()));
  for (;;) {
    if ((await controller.next()) === null) break;
  }
  await runDevin(runtime, service.reset);
  const snapshot = await runDevin(runtime, service.snapshot);
  assert.equal(snapshot.sessionId, undefined);
  assert.equal(snapshot.turns, 0);
  await runtime.dispose();
});

test("devin acp process exit retries the same session via session/load", async () => {
  const { fake, runtime, service } = await makeRuntime();
  const first = await runDevin(runtime, service.beginStreamTurn(TURN()));
  for (;;) {
    if ((await first.next()) === null) break;
  }
  // Simulate the child process dying.
  fake.onClose?.();
  const snapshot = await runDevin(runtime, service.snapshot);
  assert.equal(snapshot.sessionId, undefined);

  const controller = await runDevin(runtime, service.beginStreamTurn(TURN()));
  assert.deepEqual(fake.loaded, ["sess-1"], "next turn reloads the same session");
  assert.equal(fake.createdSessions.length, 1, "no fresh session while load succeeds");
  assert.equal(fake.prompts.at(-1)?.sessionId, "sess-1");
  for (;;) {
    if ((await controller.next()) === null) break;
  }
  await runtime.dispose();
});

test("devin acp process exit falls back to a bootstrapped fresh session", async () => {
  const { fake, runtime, service } = await makeRuntime();
  const first = await runDevin(runtime, service.beginStreamTurn(TURN()));
  for (;;) {
    if ((await first.next()) === null) break;
  }
  fake.failLoads.add("sess-1");
  fake.onClose?.();

  const controller = await runDevin(
    runtime,
    service.beginStreamTurn(TURN({ historyBootstrap: "user:\nprevious question" })),
  );
  assert.equal(fake.createdSessions.length, 2, "load failure creates a fresh session");
  const sent = fake.prompts.at(-1);
  assert.ok(
    sent?.blocks.some((b) => b.type === "resource"),
    "fresh session receives the pi history bootstrap",
  );
  for (;;) {
    if ((await controller.next()) === null) break;
  }
  const snapshot = await runDevin(runtime, service.snapshot);
  assert.equal(snapshot.sessionId, "sess-2");
  assert.equal(snapshot.turns, 1, "stale counters from the dead session are dropped");
  await runtime.dispose();
});

// Gates prove the operation reached an async boundary before we invalidate it;
// no sleeps, real processes, or live Devin credentials are needed.
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function gate() {
  const entered = deferred<void>();
  const released = deferred<void>();
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    wait: () => {
      entered.resolve();
      return released.promise;
    },
  };
}

for (const summary of [false, true]) {
  test(`${summary ? "summary" : "stream"}: already-aborted requests never start ACP`, async (t) => {
    const { fake, runtime, service } = await makeRuntime();
    t.after(() => runtime.dispose());
    const signal = AbortSignal.abort();
    await assert.rejects(
      summary
        ? runDevin(runtime, service.runSummaryTurn("summary", signal))
        : runDevin(runtime, service.beginStreamTurn(TURN({ signal }))),
      /abort/i,
    );
    assert.equal(fake.started, false);
    assert.equal(fake.prompts.length, 0);
    assert.equal(fake.cancelled.length, 0);
  });
}

for (const stage of ["start", "new", "load", "mode", "config"] as const) {
  for (const action of ["abort", "reset", "restore"] as const) {
    test(`${action} during ${stage} prevents stale setup from prompting`, async (t) => {
      const { fake, runtime, service } = await makeRuntime();
      t.after(() => runtime.dispose());
      const blocked = gate();
      const abort = new AbortController();
      if (stage === "load") {
        await runDevin(
          runtime,
          service.restoreSession({
            acpSessionId: "A",
            cwd: "/tmp/proj",
            modelId: "swe-2",
            turns: 3,
          }),
        );
        fake.loadSession = async (id) => {
          await blocked.wait();
          return { sessionId: id };
        };
      } else if (stage === "new") {
        const original = fake.newSession.bind(fake);
        fake.newSession = async (cwd) => {
          await blocked.wait();
          return original(cwd);
        };
      } else if (stage === "start") {
        fake.ensureStarted = () => blocked.wait();
      } else if (stage === "mode") {
        await runDevin(runtime, service.setMode("plan"));
        fake.setMode = () => blocked.wait();
      } else {
        fake.setConfigOption = async () => {
          await blocked.wait();
          return [];
        };
      }
      const result = runDevin(runtime, service.beginStreamTurn(TURN({ signal: abort.signal })));
      const rejected = assert.rejects(result, /aborted|superseded/);
      await blocked.entered;
      if (action === "abort") abort.abort();
      else if (action === "reset") await runDevin(runtime, service.reset);
      else
        await runDevin(
          runtime,
          service.restoreSession({
            acpSessionId: "B",
            cwd: "/tmp/proj",
            modelId: "other",
            turns: 9,
          }),
        );
      blocked.release();
      await rejected;
      assert.equal(fake.prompts.length, 0);
      assert.equal(fake.cancelled.length, 0, "no prompt was sent, so no cancel is needed");
      assert.equal(getEventListeners(abort.signal, "abort").length, 0);
      const snapshot = await runDevin(runtime, service.snapshot);
      if (action === "reset") {
        assert.equal(snapshot.sessionId, undefined);
        assert.equal(snapshot.concreteModel, undefined);
      } else if (action === "restore") {
        assert.equal(snapshot.sessionId, "B");
        assert.equal(snapshot.model, "other");
        assert.equal(snapshot.turns, 9);
        assert.equal(snapshot.concreteModel, undefined);
      }
    });
  }
}

for (const stage of ["start", "new", "config"] as const) {
  test(`summary cancelled during ${stage} never prompts and cleans up`, async (t) => {
    const { fake, runtime, service } = await makeRuntime();
    t.after(() => runtime.dispose());
    const blocked = gate();
    const abort = new AbortController();
    if (stage === "start") fake.ensureStarted = () => blocked.wait();
    else if (stage === "new") {
      const original = fake.newSession.bind(fake);
      fake.newSession = async (cwd) => {
        await blocked.wait();
        return original(cwd);
      };
    } else
      fake.setConfigOption = async () => {
        await blocked.wait();
        return [];
      };
    const rejected = assert.rejects(
      runDevin(runtime, service.runSummaryTurn("summary", abort.signal, "swe-2")),
      /abort/i,
    );
    await blocked.entered;
    abort.abort();
    blocked.release();
    await rejected;
    assert.equal(fake.prompts.length, 0);
    assert.deepEqual(fake.deleted, fake.createdSessions);
    assert.equal(fake.sessions.size, 0);
  });
}

test("abort sends exactly one cancel to the prompted session and releases listeners", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  const abort = new AbortController();
  fake.prompt = async () => new Promise(() => {});
  const controller = await runDevin(
    runtime,
    service.beginStreamTurn(TURN({ signal: abort.signal })),
  );
  const rejected = assert.rejects(controller.next(), /aborted/);
  abort.abort();
  await rejected;
  await Promise.resolve();
  assert.deepEqual(fake.cancelled, ["sess-1"]);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

test("restore removes old listeners and all session-local live state", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  await runDevin(runtime, service.beginStreamTurn(TURN()));
  const oldListener = fake.sessions.get("sess-1")!;
  oldListener({
    sessionUpdate: "tool_call",
    toolCallId: "old",
    status: "in_progress",
    title: "old shell",
  } as never);
  oldListener({ sessionUpdate: "session_info_update", title: "A title" } as never);
  assert.equal((await runDevin(runtime, service.snapshot)).liveOps.length, 1);
  await runDevin(
    runtime,
    service.restoreSession({ acpSessionId: "B", cwd: "/tmp/proj", modelId: "swe-2", turns: 0 }),
  );
  assert.equal(fake.sessions.has("sess-1"), false);
  // Even a callback already captured for delivery must be harmless.
  oldListener({ sessionUpdate: "session_info_update", title: "late A title" } as never);
  oldListener({ sessionUpdate: "tool_call", toolCallId: "late", status: "in_progress" } as never);
  const snapshot = await runDevin(runtime, service.snapshot);
  assert.equal(snapshot.sessionId, "B");
  assert.equal(snapshot.title, undefined);
  assert.deepEqual(snapshot.liveOps, []);
  assert.equal(snapshot.modeId, undefined);
  assert.equal(snapshot.availableCommands, undefined);
  assert.equal(snapshot.lastTurnStats, undefined);
});

test("invalid and server-rejected modes preserve the last accepted preference", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  await assert.rejects(runDevin(runtime, service.setMode("typo")), /Invalid/);
  await runDevin(runtime, service.setMode("plan"));
  const first = await runDevin(runtime, service.beginStreamTurn(TURN()));
  while (await first.next()) {}
  fake.setMode = async (_id, mode) => {
    fake.modes.push(mode);
    if (mode === "bypass") throw new Error("mode rejected by server");
  };
  await assert.rejects(runDevin(runtime, service.setMode("typo")), /Invalid/);
  await assert.rejects(runDevin(runtime, service.setMode("bypass")), /rejected/);
  assert.equal((await runDevin(runtime, service.snapshot)).modeId, "plan");
  // A fresh binding must still sync the accepted preference, never bypass/typo.
  await runDevin(runtime, service.setSession("/tmp/proj", { rebootstrap: true }));
  const second = await runDevin(runtime, service.beginStreamTurn(TURN()));
  while (await second.next()) {}
  assert.deepEqual(fake.modes, ["plan", "bypass", "plan"]);
});

const LIFECYCLE_MODEL: Model<Api> = {
  id: "swe-2",
  name: "SWE-2",
  api: "devin-acp",
  provider: "devin",
  baseUrl: "devin://acp",
  reasoning: true,
  input: ["text"],
  contextWindow: 262000,
  maxTokens: 64000,
  cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 0 },
};
const LIFECYCLE_FAMILIES: DevinModelFamily[] = [
  {
    id: "swe-2",
    name: "SWE-2",
    aliases: [],
    rows: ["medium", "none"].map((effort) => ({
      id: `swe-2-${effort}`,
      name: effort,
      effort: effort as "medium" | "none",
      contextWindow: 262000,
      cost: LIFECYCLE_MODEL.cost,
    })),
  },
];

test("provider abort returns during startup without waiting for ACP", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(async () => {
    await runDevin(runtime, service.close);
    await runtime.dispose();
  });
  const blocked = gate();
  fake.ensureStarted = () => blocked.wait();
  const abort = new AbortController();
  const provider = streamDevin({
    runtime,
    service,
    replay: new DevinReplayStore(),
    families: () => LIFECYCLE_FAMILIES,
    cwd: () => "/tmp/proj",
  });
  const stream = provider(
    LIFECYCLE_MODEL,
    { messages: [{ role: "user", content: "do it", timestamp: 0 }] },
    { signal: abort.signal },
  );
  await blocked.entered;
  abort.abort();
  const message = await stream.result();
  assert.equal(message.stopReason, "aborted");
  blocked.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.createdSessions.length, 0);
  assert.equal(fake.prompts.length, 0);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

for (const buffered of [false, true]) {
  test(`one ACP turn across multiple provider calls (${buffered ? "buffered" : "live"}) has unique cards and single accounting`, async (t) => {
    const { fake, runtime, service } = await makeRuntime();
    t.after(async () => {
      await runDevin(runtime, service.close);
      await runtime.dispose();
    });
    const replay = new DevinReplayStore();
    const provider = streamDevin({
      runtime,
      service,
      replay,
      families: () => LIFECYCLE_FAMILIES,
      cwd: () => "/tmp/proj",
    });
    const context: Context = { messages: [{ role: "user", content: "do it", timestamp: 0 }] };
    const response = deferred<{
      stopReason: string;
      usage: { inputTokens: number; outputTokens: number };
    }>();
    const started = deferred<void>();
    const emit = (update: unknown) => fake.sessions.get("sess-1")!(update as never);
    const tool = (id: string, initial = false) => {
      emit({
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: id,
        status: initial ? "completed" : "in_progress",
        content: initial
          ? [{ type: "content", content: { type: "text", text: `${id} result` } }]
          : undefined,
      });
      if (!initial)
        emit({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: `${id} result` } }],
        });
    };
    const finish = () => {
      emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all done" } });
      response.resolve({ stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } });
    };
    fake.prompt = async (sessionId, blocks) => {
      fake.prompts.push({ sessionId, blocks });
      emit({
        sessionUpdate: "usage_update",
        used: 9000,
        size: 262000,
        _meta: {
          "cognition.ai/inputTokens": 100,
          "cognition.ai/outputTokens": 10,
          "cognition.ai/cachedReadTokens": 30,
        },
      });
      tool("first");
      if (buffered) {
        tool("second", true);
        finish();
      }
      started.resolve();
      return response.promise;
    };
    const messages: AssistantMessage[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const stream = provider(LIFECYCLE_MODEL, context, { reasoning: undefined });
      await started.promise;
      if (!buffered && i === 1) tool("second", true);
      if (!buffered && i === 2) finish();
      const message = await stream.result();
      messages.push(message);
      context.messages.push(message);
      assert.equal(
        message.stopReason,
        i < 2 ? "toolUse" : "stop",
        message.errorMessage ?? "unexpected stop reason",
      );
      for (const call of message.content) {
        if (call.type !== "toolCall") continue;
        ids.push(call.id);
        const result = replay.take(call.id);
        assert.ok(result);
        assert.equal(result.error, undefined);
        assert.equal(result.output, `${i === 0 ? "first" : "second"} result`);
        context.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: result.output! }],
          isError: false,
          timestamp: 0,
        });
      }
    }
    assert.equal(fake.prompts.length, 1, "provider re-entry must not re-prompt ACP");
    assert.equal(new Set(ids).size, 2);
    assert.deepEqual(
      fake.configSets,
      [{ configId: "model", value: "swe-2-none" }],
      "Pi off must not select the default medium row",
    );
    assert.deepEqual(
      messages.map((m) => m.usage.input),
      [70, 0, 100],
      "each segment bills the usage observed since the previous message",
    );
    assert.equal(
      messages.reduce((sum, m) => sum + m.usage.cacheRead, 0),
      30,
    );
    assert.equal(
      messages.reduce((sum, m) => sum + m.usage.output, 0),
      30,
    );
    assert.equal(
      messages.reduce((sum, m) => sum + m.usage.totalTokens, 0),
      230,
    );
    assert.ok(Math.abs(messages.reduce((sum, m) => sum + m.usage.cost.total, 0) - 0.00049) < 1e-12);
    assert.equal((await runDevin(runtime, service.snapshot)).contextTokens, 9000);
    // A later turn may reuse ACP tool IDs, but never Pi replay IDs.
    const next = await provider(LIFECYCLE_MODEL, {
      messages: [{ role: "user", content: "new request", timestamp: 1 }],
    }).result();
    const nextCall = next.content.find((c) => c.type === "toolCall");
    assert.ok(nextCall);
    assert.ok(!ids.includes(nextCall.id));
    assert.equal(fake.prompts.length, 2);
  });
}

for (const outcome of ["error", "aborted", "stop"] as const) {
  test(`usage survives replay segments and terminal ${outcome}`, async (t) => {
    const { fake, runtime, service } = await makeRuntime();
    t.after(async () => {
      await runDevin(runtime, service.close);
      await runtime.dispose();
    });
    const pending = deferred<{
      stopReason: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cachedReadTokens: number;
        cachedWriteTokens: number;
      };
    }>();
    const abort = new AbortController();
    fake.prompt = async (sessionId, blocks) => {
      fake.prompts.push({ sessionId, blocks });
      const emit = fake.sessions.get(sessionId)!;
      emit({
        sessionUpdate: "usage_update",
        used: 120,
        size: 262000,
        _meta: { "cognition.ai/inputTokens": 100, "cognition.ai/outputTokens": 20 },
      } as never);
      emit({
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "read",
        status: "completed",
      } as never);
      return pending.promise;
    };
    const provider = streamDevin({
      runtime,
      service,
      replay: new DevinReplayStore(),
      families: () => LIFECYCLE_FAMILIES,
      cwd: () => "/tmp/proj",
    });
    const model = {
      ...LIFECYCLE_MODEL,
      cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 },
    };
    const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
    const first = await provider(model, context, { signal: abort.signal }).result();
    assert.equal(first.stopReason, "toolUse");
    // The segment bills the first request's usage_update (100 in + 20 out).
    assert.equal(first.usage.totalTokens, 120);
    const last = provider(model, context, { signal: abort.signal }).result();
    fake.sessions.get("sess-1")!({
      sessionUpdate: "usage_update",
      used: 250,
      size: 262000,
      _meta: {
        "cognition.ai/inputTokens": 200,
        "cognition.ai/outputTokens": 50,
        "cognition.ai/cachedReadTokens": 90,
        "cognition.ai/cachedWriteTokens": 30,
      },
    } as never);
    // Let the provider drain the latest snapshot before interruption.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (outcome === "error") pending.reject(new Error("transport failed"));
    else if (outcome === "aborted") {
      abort.abort();
      pending.resolve({ stopReason: "cancelled" });
    } else
      pending.resolve({
        stopReason: "end_turn",
        usage: { inputTokens: 180, outputTokens: 40, cachedReadTokens: 80, cachedWriteTokens: 20 },
      });
    const final = await last;
    assert.equal(final.stopReason, outcome);
    // The terminal message bills only the share no segment persisted yet:
    // error/aborted keep the second request's snapshot, while stop adds the
    // response's distinct final-request usage on top.
    assert.equal(final.usage.input, outcome === "stop" ? 160 : 80);
    assert.equal(final.usage.cacheRead, outcome === "stop" ? 170 : 90);
    assert.equal(final.usage.cacheWrite, outcome === "stop" ? 50 : 30);
    assert.equal(final.usage.output, outcome === "stop" ? 90 : 50);
    assert.equal(final.usage.totalTokens, outcome === "stop" ? 470 : 250);
    assert.ok(Math.abs(final.usage.cost.total - (outcome === "stop" ? 0.001 : 0.00054)) < 1e-12);
  });
}

test("load-replayed usage seeds the snapshot but never the turn's accounting", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(async () => {
    await runDevin(runtime, service.close);
    await runtime.dispose();
  });
  await runDevin(
    runtime,
    service.restoreSession({
      acpSessionId: "loaded",
      cwd: "/tmp/proj",
      modelId: "swe-2",
      turns: 2,
    }),
  );
  // The real client forwards the loadStats replay tail through the session
  // listener while session/load is in flight.
  fake.loadSession = async (id) => {
    fake.sessions.get(id)?.({
      sessionUpdate: "usage_update",
      used: 90239,
      size: 262000,
      _meta: {
        "cognition.ai/inputTokens": 90029,
        "cognition.ai/outputTokens": 210,
        "cognition.ai/cachedReadTokens": 89273,
      },
    } as never);
    return { sessionId: id };
  };
  const prompted = deferred<void>();
  fake.prompt = async (sessionId, blocks) => {
    fake.prompts.push({ sessionId, blocks });
    prompted.resolve();
    return new Promise(() => {});
  };
  const abort = new AbortController();
  const provider = streamDevin({
    runtime,
    service,
    replay: new DevinReplayStore(),
    families: () => LIFECYCLE_FAMILIES,
    cwd: () => "/tmp/proj",
  });
  const messagePromise = provider(
    LIFECYCLE_MODEL,
    { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    { signal: abort.signal },
  ).result();
  await prompted.promise;
  // Let the provider take the controller and drain queued activities, then
  // abort before the turn reports any usage of its own.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  const message = await messagePromise;
  assert.equal(message.stopReason, "aborted");
  assert.equal(
    message.usage.totalTokens,
    0,
    "the replayed snapshot is prior-turn usage, not this turn's",
  );
  // The same snapshot still lands in the runtime snapshot for /devin-usage.
  const snap = await runDevin(runtime, service.snapshot);
  assert.equal(snap.usage?.inputTokens, 90029);
  assert.equal(snap.contextTokens, 90239);
});

test("pre-prompt straggler usage never seeds the next turn's accounting", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(async () => {
    await runDevin(runtime, service.close);
    await runtime.dispose();
  });
  // Turn 1 completes so the session stays live for reuse.
  const first = await runDevin(runtime, service.beginStreamTurn(TURN()));
  for (;;) {
    if ((await first.next()) === null) break;
  }
  // Turn 2 resolves a different concrete model, so syncConfig issues
  // setConfigOption while no prompt is in flight. A straggler usage_update
  // (the previous turn's tail) arriving in that window is session state,
  // not turn-2 usage.
  fake.setConfigOption = async (_id, configId, value) => {
    fake.configSets.push({ configId, value });
    fake.sessions.get("sess-1")?.({
      sessionUpdate: "usage_update",
      used: 90239,
      size: 262000,
      _meta: { "cognition.ai/inputTokens": 90029, "cognition.ai/outputTokens": 210 },
    } as never);
    return [];
  };
  const prompted = deferred<void>();
  fake.prompt = async (sessionId, blocks) => {
    fake.prompts.push({ sessionId, blocks });
    if (fake.prompts.length === 2) prompted.resolve();
    return new Promise(() => {});
  };
  const abort = new AbortController();
  const provider = streamDevin({
    runtime,
    service,
    replay: new DevinReplayStore(),
    families: () => LIFECYCLE_FAMILIES,
    cwd: () => "/tmp/proj",
  });
  const messagePromise = provider(
    LIFECYCLE_MODEL,
    { messages: [{ role: "user", content: "again", timestamp: 1 }] },
    { signal: abort.signal },
  ).result();
  await prompted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  const message = await messagePromise;
  assert.equal(message.stopReason, "aborted");
  assert.equal(message.usage.totalTokens, 0);
  assert.deepEqual(fake.configSets.at(-1), { configId: "model", value: "swe-2-none" });
});

test("matching turn_stats cumulative sums become the turn's billed usage", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(async () => {
    await runDevin(runtime, service.close);
    await runtime.dispose();
  });
  fake.prompt = async (sessionId, blocks, opts) => {
    fake.prompts.push({ sessionId, blocks, clientMessageId: opts?.clientMessageId });
    // The last-request snapshot usage_update reports mid-turn.
    fake.sessions.get(sessionId)?.({
      sessionUpdate: "usage_update",
      used: 14627,
      size: 262000,
      _meta: {
        "cognition.ai/inputTokens": 14613,
        "cognition.ai/outputTokens": 14,
        "cognition.ai/cachedReadTokens": 6656,
      },
    } as never);
    // A stale turn_stats (another turn's clientMessageId) must be ignored.
    fake.customHandler?.("_cognition.ai/turn_stats", {
      sessionId,
      turnClientMessageId: "some-other-turn",
      responseDimensions: [
        { uid: "input_tokens", kind: { type: "cumulativeMetric", value: 999999 } },
      ],
    });
    // This turn's own turn_stats: cumulative sums across its internal
    // requests (input_tokens is the uncached sum; the two internal requests
    // here totalled 22454 uncached + 6656 cached + 80 output).
    fake.customHandler?.("_cognition.ai/turn_stats", {
      sessionId,
      turnClientMessageId: opts?.clientMessageId,
      responseDimensions: [
        { uid: "agent_messages", kind: { type: "cumulativeMetric", value: 2 } },
        { uid: "input_tokens", kind: { type: "cumulativeMetric", value: 22454 } },
        { uid: "output_tokens", kind: { type: "cumulativeMetric", value: 80 } },
        { uid: "cached_input_tokens", kind: { type: "cumulativeMetric", value: 6656 } },
      ],
    });
    // The prompt response still carries last-request usage; it must not
    // clobber the cumulative sums that already landed.
    return { stopReason: "end_turn", usage: { inputTokens: 14613, outputTokens: 14 } };
  };
  const provider = streamDevin({
    runtime,
    service,
    replay: new DevinReplayStore(),
    families: () => LIFECYCLE_FAMILIES,
    cwd: () => "/tmp/proj",
  });
  const message = await provider(
    LIFECYCLE_MODEL,
    { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    {},
  ).result();
  assert.equal(message.stopReason, "stop");
  assert.equal(message.usage.input, 22454);
  assert.equal(message.usage.output, 80);
  assert.equal(message.usage.cacheRead, 6656);
  assert.equal(message.usage.cacheWrite, 0);
  assert.equal(message.usage.totalTokens, 29190);
  assert.ok(fake.prompts[0].clientMessageId, "the turn stamps a correlation id");
});

test("summary usage merges streamed cache metadata with prompt-response totals", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  fake.prompt = async (id) => {
    fake.sessions.get(id)!({
      sessionUpdate: "usage_update",
      used: 100,
      size: 262000,
      _meta: { "cognition.ai/cachedReadTokens": 30, "cognition.ai/cachedWriteTokens": 10 },
    } as never);
    return { stopReason: "end_turn", usage: { inputTokens: 80, outputTokens: 20 } };
  };
  const result = await runDevin(runtime, service.runSummaryTurn("summarize"));
  assert.equal(result.usage?.inputTokens, 80);
  assert.equal(result.usage?.outputTokens, 20);
  assert.equal(result.usage?.cachedReadTokens, 30);
  assert.equal(result.usage?.cachedWriteTokens, 10);
});

test("superseding a live turn waits for the cancelled prompt before re-prompting", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  const first = deferred<{ stopReason: string }>();
  fake.prompt = async (sessionId, blocks) => {
    fake.prompts.push({ sessionId, blocks });
    // The first ACP prompt stays in flight until the test settles it.
    if (fake.prompts.length === 1) return first.promise;
    return { stopReason: "end_turn" };
  };

  const c1 = await runDevin(runtime, service.beginStreamTurn(TURN()));
  const second = runDevin(runtime, service.beginStreamTurn(TURN({ prompt: "second" })));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fake.prompts.length, 1, "the new prompt must wait for the cancel to land");
  assert.deepEqual(fake.cancelled, ["sess-1"], "the superseded turn is cancelled first");
  await assert.rejects(c1.next(), /superseded/);

  first.resolve({ stopReason: "cancelled" });
  const c2 = await second;
  assert.equal(fake.prompts.length, 2, "the new prompt is issued once the old one settles");
  assert.equal(fake.prompts[1].sessionId, "sess-1", "the live session is reused");
  const activities = [];
  for (;;) {
    const a = await c2.next();
    if (a === null) break;
    activities.push(a);
  }
  assert.deepEqual(activities.at(-1), {
    type: "result",
    stopReason: "end_turn",
    usage: {
      inputTokens: undefined,
      outputTokens: undefined,
      cachedReadTokens: undefined,
      cachedWriteTokens: undefined,
    },
  });
  assert.equal((await runDevin(runtime, service.snapshot)).turns, 1);
});

test("deleteSession reports whether it dropped the bound session", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  const controller = await runDevin(runtime, service.beginStreamTurn(TURN()));
  for (;;) {
    if ((await controller.next()) === null) break;
  }
  assert.equal(await runDevin(runtime, service.deleteSession("other-session")), false);
  assert.equal(
    (await runDevin(runtime, service.snapshot)).sessionId,
    "sess-1",
    "an unrelated delete keeps the branch binding",
  );
  assert.equal(await runDevin(runtime, service.deleteSession("sess-1")), true);
  assert.equal((await runDevin(runtime, service.snapshot)).sessionId, undefined);
  assert.deepEqual(fake.deleted, ["other-session", "sess-1"]);
});

test("transformPrompt replaces the outgoing ACP prompt blocks", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  const seen: { sessionId: string; prompt: unknown[] }[] = [];
  const controller = await runDevin(
    runtime,
    service.beginStreamTurn(
      TURN({
        transformPrompt: (request) => {
          seen.push({ sessionId: request.sessionId, prompt: request.prompt });
          return [...request.prompt, { type: "text", text: "injected" }];
        },
      }),
    ),
  );
  for (;;) {
    if ((await controller.next()) === null) break;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, "sess-1", "the hook sees the live ACP session id");
  assert.deepEqual(
    fake.prompts[0].blocks.map((block) => (block.type === "text" ? block.text : block.type)),
    ["hi", "injected"],
  );
});

test("transformPrompt can decline by returning undefined", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  const controller = await runDevin(
    runtime,
    service.beginStreamTurn(TURN({ transformPrompt: () => undefined })),
  );
  for (;;) {
    if ((await controller.next()) === null) break;
  }
  assert.deepEqual(
    fake.prompts[0].blocks.map((block) => (block.type === "text" ? block.text : block.type)),
    ["hi"],
  );
});

test("runSummaryTurn applies the payload hook to its disposable session", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  await runDevin(
    runtime,
    service.runSummaryTurn("summarize this", undefined, undefined, () => [
      { type: "text", text: "rewritten summary request" },
    ]),
  );
  const sent = fake.prompts[0];
  assert.deepEqual(sent.blocks, [{ type: "text", text: "rewritten summary request" }]);
  assert.equal(sent.sessionId, fake.createdSessions[0], "sent to the disposable session");
});

test("snapshot.usage merges usage_update totals and turn_stats dims", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  const controller = await runDevin(runtime, service.beginStreamTurn(TURN()));
  for (;;) {
    if ((await controller.next()) === null) break;
  }

  fake.sessions.get("sess-1")?.({
    sessionUpdate: "usage_update",
    used: 9000,
    size: 262000,
    _meta: {
      "cognition.ai/inputTokens": 100,
      "cognition.ai/outputTokens": 10,
      "cognition.ai/totalAcuCost": 0.02,
    },
  } as never);
  const snap = await runDevin(runtime, service.snapshot);
  assert.equal(snap.usage?.inputTokens, 100);
  assert.equal(snap.usage?.totalAcuCost, 0.02);
  assert.equal(snap.contextTokens, 9000);

  // A later usage_update without counters keeps the earlier totals.
  fake.sessions.get("sess-1")?.({
    sessionUpdate: "usage_update",
    used: 9500,
    size: 262000,
  } as never);
  const snap2 = await runDevin(runtime, service.snapshot);
  assert.equal(snap2.usage?.inputTokens, 100);
  assert.equal(snap2.contextTokens, 9500);

  fake.customHandler?.("_cognition.ai/turn_stats", {
    sessionId: "sess-1",
    responseDimensions: [
      {
        uid: "model",
        groupTitle: "Response Statistics",
        label: "Model",
        kind: { type: "metric", value: "SWE-2 Max" },
      },
    ],
  });
  const snap3 = await runDevin(runtime, service.snapshot);
  assert.equal(snap3.lastTurnStats?.dimensions?.[0].label, "Model");

  // agent_stopped still wins the whole stats object.
  fake.customHandler?.("_cognition.ai/agent_stopped", {
    cause: "end_turn",
    stats: { inputTokens: 100, outputTokens: 10, tokensPerSec: 5 },
  });
  const snap4 = await runDevin(runtime, service.snapshot);
  assert.equal(snap4.lastTurnStats?.tokensPerSec, 5);
  assert.equal(snap4.lastTurnStats?.dimensions, undefined);
});

test("connection_retry surfaces on the snapshot until progress resumes", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());

  // With no bound session the retry cannot be attributed — ignored.
  fake.customHandler?.("_cognition.ai/connection_retry", {
    sessionId: "nowhere",
    attempt: 1,
    maxAttempts: 5,
  });
  assert.equal((await runDevin(runtime, service.snapshot)).retry, undefined);

  // A pending prompt keeps the turn open so retries arrive mid-turn.
  const pending = deferred<{ stopReason: string }>();
  fake.prompt = async (sessionId, blocks) => {
    fake.prompts.push({ sessionId, blocks });
    return pending.promise;
  };
  const controller = await runDevin(runtime, service.beginStreamTurn(TURN()));
  const sessionId = fake.createdSessions[0];

  fake.customHandler?.("_cognition.ai/connection_retry", {
    sessionId,
    attempt: 2,
    maxAttempts: 5,
    isStreamRetry: false,
  });
  let snap = await runDevin(runtime, service.snapshot);
  assert.equal(snap.retry?.attempt, 2);
  assert.equal(snap.retry?.maxAttempts, 5);
  assert.equal(snap.retry?.isStreamRetry, false);
  // The retry activity also reaches the live turn controller.
  assert.equal((await controller.next())?.type, "retry");

  // Retries attributed to another session (e.g. a summary session) are ignored.
  fake.customHandler?.("_cognition.ai/connection_retry", {
    sessionId: "other-session",
    attempt: 9,
    maxAttempts: 9,
  });
  snap = await runDevin(runtime, service.snapshot);
  assert.equal(snap.retry?.attempt, 2);

  // Streamed content means the backend stream recovered — the state clears.
  fake.sessions.get(sessionId)?.({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "back" },
  } as never);
  snap = await runDevin(runtime, service.snapshot);
  assert.equal(snap.retry, undefined);

  pending.resolve({ stopReason: "end_turn" });
  for (;;) {
    if ((await controller.next()) === null) break;
  }
});

test("connection_retry clears when the turn resolves", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  const pending = deferred<{ stopReason: string }>();
  fake.prompt = async (sessionId, blocks) => {
    fake.prompts.push({ sessionId, blocks });
    return pending.promise;
  };
  await runDevin(runtime, service.beginStreamTurn(TURN()));
  const sessionId = fake.createdSessions[0];
  fake.customHandler?.("_cognition.ai/connection_retry", {
    sessionId,
    attempt: 3,
    isStreamRetry: true,
  });
  assert.equal((await runDevin(runtime, service.snapshot)).retry?.attempt, 3);
  // The turn's terminal result means no further retrying — even if no
  // content chunk streamed after the last attempt.
  pending.resolve({ stopReason: "end_turn" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await runDevin(runtime, service.snapshot)).retry, undefined);
});

test("terminal updates landing in the supersede window still clear liveOps", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  const pending = deferred<{ stopReason: string }>();
  fake.prompt = async (sessionId, blocks) => {
    fake.prompts.push({ sessionId, blocks });
    return pending.promise;
  };
  await runDevin(runtime, service.beginStreamTurn(TURN()));
  const sessionId = fake.createdSessions[0];
  fake.sessions.get(sessionId)?.({
    sessionUpdate: "tool_call",
    toolCallId: "exec_1",
    title: "Ran sleep",
    kind: "execute",
    status: "in_progress",
  } as never);
  assert.equal((await runDevin(runtime, service.snapshot)).liveOps.length, 1);

  // Superseding the turn bumps the generation; until the next turn re-attaches
  // its own listener the old registration still receives the cancelled turn's
  // trailing updates — devin emits the kill confirmations exactly here.
  const staleListener = fake.sessions.get(sessionId)!;
  const next = runDevin(
    runtime,
    service.beginStreamTurn(TURN({ prompt: "next", blocks: [{ type: "text", text: "next" }] })),
  );
  staleListener({
    sessionUpdate: "tool_call_update",
    toolCallId: "exec_1",
    status: "completed",
  } as never);
  pending.resolve({ stopReason: "cancelled" });
  const controller = await next;
  for (;;) {
    if ((await controller.next()) === null) break;
  }
  const snap = await runDevin(runtime, service.snapshot);
  assert.equal(snap.liveOps.length, 0, "stale-generation terminal update cleared the op");
});

test("child process exit drops in-flight op tracking", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  const pending = deferred<{ stopReason: string }>();
  fake.prompt = async (sessionId, blocks) => {
    fake.prompts.push({ sessionId, blocks });
    return pending.promise;
  };
  await runDevin(runtime, service.beginStreamTurn(TURN()));
  const sessionId = fake.createdSessions[0];
  fake.sessions.get(sessionId)?.({
    sessionUpdate: "tool_call",
    toolCallId: "exec_1",
    title: "Ran sleep",
    kind: "execute",
    status: "in_progress",
  } as never);
  assert.equal((await runDevin(runtime, service.snapshot)).liveOps.length, 1);
  fake.onClose?.();
  assert.equal(
    (await runDevin(runtime, service.snapshot)).liveOps.length,
    0,
    "the dead child cannot report terminal state — stop listing its ops",
  );
});

test("dismissOp drops a tracked op without touching the session", async (t) => {
  const { fake, runtime, service } = await makeRuntime();
  t.after(() => runtime.dispose());
  await runDevin(runtime, service.beginStreamTurn(TURN()));
  const sessionId = fake.createdSessions[0];
  fake.sessions.get(sessionId)?.({
    sessionUpdate: "tool_call",
    toolCallId: "exec_1",
    title: "Ran sleep",
    kind: "execute",
    status: "in_progress",
  } as never);
  assert.equal((await runDevin(runtime, service.snapshot)).liveOps.length, 1);
  assert.equal(await runDevin(runtime, service.dismissOp("exec_1")), true);
  assert.equal((await runDevin(runtime, service.snapshot)).liveOps.length, 0);
  assert.equal(await runDevin(runtime, service.dismissOp("exec_1")), false);
});
