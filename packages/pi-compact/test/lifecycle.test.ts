import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { latestCheckpoint } from "../src/checkpoint.ts";
import { resolveCompactionRouteForApi } from "../src/model-api.ts";
import { compactionSystemPrompt } from "../src/prompt.ts";
import type { JsonObject } from "../src/protocol.ts";
import { completedResponse, harness, opaque, sol, terra, userItem } from "./fixtures.ts";

async function replay(h: ReturnType<typeof harness>) {
  const original = h.sm.buildSessionContext().messages;
  const projected = await h.call<{ messages: AgentMessage[] } | undefined>("context", {
    messages: original,
  });
  if (!projected) return undefined;
  const input = convertToLlm(projected.messages).map((message) => {
    assert.equal(message.role, "user");
    return userItem(
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
    );
  });
  return h.call<JsonObject | undefined>("before_provider_request", { payload: { input } });
}

test("successful compaction transmits custom instructions and yields a replayable checkpoint", async () => {
  const h = harness();
  const event = h.event();
  event.customInstructions = "Preserve audit codes verbatim: focus-sentinel";
  const result = await h.compact(event);
  assert(result?.compaction);
  assert.equal(h.payloads.length, 1);
  assert.match(
    String(h.payloads[0].instructions),
    /Base system prompt.*compaction only:.*focus-sentinel/s,
  );
  assert.equal((h.payloads[0].input as JsonObject[]).at(-1)?.type, "compaction_trigger");
  const { summary, firstKeptEntryId, tokensBefore, details } = result.compaction;
  h.sm.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, true);
  const payload = await replay(h);
  assert(payload);
  const expected = userItem("old-user-code: old-123");
  assert.deepEqual(payload.input, [{ role: expected.role, content: expected.content }, opaque]);
  // Custom focus only affects the compaction request, not future session instructions.
  assert.equal(JSON.stringify(payload).includes("focus-sentinel"), false);
});

test("blank instructions preserve the original prompt/cache prefix", () => {
  assert.equal(compactionSystemPrompt("unchanged"), "unchanged");
  assert.equal(compactionSystemPrompt("unchanged", "  \n"), "unchanged");
});

test("disabled compaction still replays an existing checkpoint across Codex models", async () => {
  const h = harness({ prior: true, settings: { enabled: false } });
  Object.assign(h.ctx, { model: terra });
  const payload = await replay(h);
  assert(payload);
  assert.deepEqual(payload.input, [userItem("old-user-code: old-123"), opaque]);
  await h.call("model_select", { model: terra });
  assert.deepEqual(h.notifications, []);
});

for (const [name, model] of [
  ["different provider", { ...sol, provider: "other-provider" }],
  ["different API", { ...sol, api: "openai-responses" }],
  ["different endpoint", { ...terra, baseUrl: "https://other.invalid/backend-api" }],
] as const) {
  test(`does not send opaque history to a ${name}`, async () => {
    const h = harness({ prior: true });
    Object.assign(h.ctx, { model });
    assert.equal(await replay(h), undefined);
    assert.deepEqual(await h.compact(), { cancel: true });
    assert.equal(h.payloads.length, 0);
  });
}

test("native compaction remains available without an opaque checkpoint", async () => {
  const h = harness({
    fetch: async () => {
      throw new Error("network unavailable");
    },
  });
  assert.equal(await h.compact(), undefined);
  assert.match(h.notifications.at(-1)!, /using Pi compaction/);
});

for (const [name, settings] of [
  ["disabled", { enabled: false }],
  ["unsupported Codex protocol", { protocol: "responses-compact" as const }],
] as const) {
  test(`${name} cancels compaction without altering the existing checkpoint`, async () => {
    const h = harness({ prior: true, settings });
    const before = structuredClone(h.sm.getBranch());
    assert.deepEqual(await h.compact(), { cancel: true });
    assert.deepEqual(h.sm.getBranch(), before);
    assert.equal(h.payloads.length, 0);
    assert.match(h.notifications.at(-1)!, /preserving the existing opaque checkpoint/);
  });
}

test("network failure preserves the checkpoint and never announces native fallback", async () => {
  const h = harness({
    prior: true,
    settings: { notifyOnFallback: false },
    fetch: async () => {
      throw new Error("network unavailable");
    },
  });
  const before = structuredClone(h.sm.getBranch());
  assert.deepEqual(await h.compact(), { cancel: true });
  assert.deepEqual(h.sm.getBranch(), before);
  assert(latestCheckpoint(h.sm.getBranch()));
  assert.equal(
    h.notifications.some((text) => text.includes("using Pi compaction")),
    false,
  );
  assert.match(h.notifications.at(-1)!, /preserving the existing opaque checkpoint/);
});

test("transient failures can recover on later attempts instead of permanently blacklisting", async () => {
  let attempts = 0;
  const h = harness({
    prior: true,
    fetch: async () => {
      if (++attempts <= 2) throw new Error("request timed out");
      return completedResponse();
    },
  });
  assert.deepEqual(await h.compact(), { cancel: true });
  assert.deepEqual(await h.compact(), { cancel: true });
  assert((await h.compact())?.compaction);
  assert.equal(attempts, 3);
});

test("definitive route failure is not retried, and still cannot trigger lossy native fallback", async () => {
  const h = harness({
    prior: true,
    fetch: async () => new Response("404 page not found", { status: 404 }),
  });
  assert.deepEqual(await h.compact(), { cancel: true });
  assert.deepEqual(await h.compact(), { cancel: true });
  assert.equal(h.payloads.length, 1);
});

test("malformed opaque details are preserved rather than replaced by native compaction", async () => {
  const h = harness({ prior: true });
  const checkpoint = h.sm
    .getBranch()
    .slice()
    .reverse()
    .find((entry) => entry.type === "compaction")!;
  checkpoint.details = { kind: "pi-codex-remote-compaction", version: 2 };
  assert.deepEqual(await h.compact(), { cancel: true });
  assert.equal(h.payloads.length, 0);
});

test("recompaction on another Codex model expands the existing opaque item", async () => {
  const h = harness({ prior: true });
  Object.assign(h.ctx, { model: terra });
  const firstKeptEntryId = h.sm.appendMessage({
    role: "user",
    content: "new task",
    timestamp: Date.now(),
  });
  const result = await h.compact(h.event(firstKeptEntryId));
  assert(result?.compaction);
  const input = h.payloads[0].input as JsonObject[];
  assert(input.some((item) => item.type === "compaction"));
  assert.equal(input.at(-1)?.type, "compaction_trigger");
  assert.equal(h.payloads[0].model, terra.id);
});

test("an aborted request does not fetch or overwrite the checkpoint", async () => {
  const h = harness({ prior: true });
  const event = h.event();
  event.signal = AbortSignal.abort();
  assert.deepEqual(await h.compact(event), { cancel: true });
  assert.equal(h.payloads.length, 0);
});

test("session shutdown aborts an in-flight compaction without replacing history", async () => {
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const h = harness({
    prior: true,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        started();
      }),
  });
  const before = structuredClone(h.sm.getBranch());
  const pending = h.compact();
  await ready;
  await h.call("session_shutdown", {});
  assert.deepEqual(await pending, { cancel: true });
  assert.deepEqual(h.sm.getBranch(), before);
});

test("Codex compact API is rejected locally instead of making a known-doomed request", async () => {
  const route = resolveCompactionRouteForApi("openai-codex-responses", {
    enabled: true,
    protocol: "responses-compact",
  });
  assert.equal(route.kind, "native");
  const h = harness({ settings: { protocol: "responses-compact" } });
  assert.equal(await h.compact(), undefined);
  assert.equal(h.payloads.length, 0);
  assert.match(h.notifications.at(-1)!, /Set protocol to auto or remote-v2/);
});
