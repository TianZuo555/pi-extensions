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
