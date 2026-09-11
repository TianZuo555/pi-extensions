import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
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
  async cancel() {}
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
