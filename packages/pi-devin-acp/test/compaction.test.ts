import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCompactForwarder,
  createCompactSend,
  type CompactForwardUi,
  type CompactionReason,
} from "../lib/compaction.ts";

function harness(cooldownMs = 60_000) {
  const sent: string[] = [];
  const notices: string[] = [];
  const pending: Array<() => void> = [];
  let now = 1_700_000_000_000;
  const forward = createCompactForwarder({
    cooldownMs,
    now: () => now,
    schedule: (run) => pending.push(run),
    send: (text) => sent.push(text),
  });
  const ui: CompactForwardUi = { notify: (message) => notices.push(message) };
  const flush = () => {
    for (const run of pending.splice(0)) run();
  };
  return {
    forward,
    sent,
    notices,
    flush,
    advance: (ms: number) => {
      now += ms;
    },
    run: (
      reason: CompactionReason,
      instructions?: string,
      target: CompactForwardUi | undefined = ui,
    ) => {
      forward(reason, instructions, target);
      flush();
    },
  };
}

test("manual compaction forwards the bare command and says so", () => {
  const h = harness();
  h.run("manual");
  assert.deepEqual(h.sent, ["/compact"]);
  assert.match(h.notices[0], /running devin's \/compact instead/);
});

test("manual compaction forwards its custom instructions inline", () => {
  const h = harness();
  h.run("manual", "  keep the test findings  ");
  assert.deepEqual(h.sent, ["/compact keep the test findings"]);
});

test("manual compaction is never rate limited", () => {
  const h = harness();
  h.run("manual");
  h.run("manual");
  assert.deepEqual(h.sent, ["/compact", "/compact"]);
});

test("auto triggers forward once per cooldown, then resume", () => {
  const h = harness(60_000);
  h.run("threshold");
  assert.equal(h.sent.length, 1);

  h.run("threshold");
  h.run("overflow");
  assert.equal(h.sent.length, 1);

  h.advance(60_000);
  h.run("threshold");
  assert.equal(h.sent.length, 2);
});

test("auto notices name the trigger that was forwarded", () => {
  const h = harness();
  h.run("overflow");
  assert.match(h.notices[0], /forwarding overflow compaction/);
});

test("headless auto forwards still send but skip the notice", () => {
  const h = harness();
  h.forward("threshold", undefined, undefined);
  h.flush();
  assert.deepEqual(h.sent, ["/compact"]);
  assert.deepEqual(h.notices, []);
});

test("the forward is deferred one tick so the cancelled pass finishes first", () => {
  const h = harness();
  h.forward("manual", undefined, undefined);
  assert.deepEqual(h.sent, []);
  h.flush();
  assert.deepEqual(h.sent, ["/compact"]);
});

test("forwarded commands are delivered as follow-ups, never as bare prompts", () => {
  const calls: Array<{ text: string; options: unknown }> = [];
  const send = createCompactSend((text, options) => calls.push({ text, options }));
  send("/compact keep it short");
  assert.deepEqual(calls, [
    {
      text: "/compact keep it short",
      // Without deliverAs, pi rejects the send with "Agent is already
      // processing" whenever the forward is triggered while a turn runs.
      options: { expandPromptTemplates: false, deliverAs: "followUp" },
    },
  ]);
});
