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
  prompts: { sessionId: string; blocks: ContentBlock[] }[] = [];
  nextId = 0;
  failLoads = new Set<string>();
  deleted: string[] = [];
  modes: string[] = [];
  cancelled: string[] = [];
  configSets: { configId: string; value: string }[] = [];
  onClose: (() => void) | undefined;

  async ensureStarted() {
    this.started = true;
  }
  setSessionListener(id: string, fn: DevinSessionListener | undefined) {
    if (fn) this.sessions.set(id, fn);
    else this.sessions.delete(id);
  }
  setCustomNotificationHandler() {}
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
  async prompt(sessionId: string, blocks: ContentBlock[]) {
    this.prompts.push({ sessionId, blocks });
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
  async close() {}
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
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
      [0, 0, 70],
    );
    assert.equal(
      messages.reduce((sum, m) => sum + m.usage.cacheRead, 0),
      30,
    );
    assert.equal(
      messages.reduce((sum, m) => sum + m.usage.output, 0),
      20,
    );
    assert.equal(
      messages.reduce((sum, m) => sum + m.usage.totalTokens, 0),
      120,
    );
    assert.ok(Math.abs(messages.reduce((sum, m) => sum + m.usage.cost.total, 0) - 0.00025) < 1e-12);
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
    usage: { inputTokens: undefined, outputTokens: undefined },
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
