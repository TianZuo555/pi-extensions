import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCompactForwarder,
  createCompactSend,
  type CompactForwardUi,
} from "../lib/compaction.ts";

function harness() {
  const sent: string[] = [];
  const notices: string[] = [];
  const pending: Array<() => void> = [];
  const forward = createCompactForwarder({
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
    run: (instructions?: string, target: CompactForwardUi | undefined = ui) => {
      forward(instructions, target);
      flush();
    },
  };
}

test("the forward sends devin's own /compact command and says so", () => {
  const h = harness();
  h.run();
  assert.deepEqual(h.sent, ["/compact"]);
  assert.match(h.notices[0], /running devin's \/compact instead/);
});

test("the forward carries custom instructions inline", () => {
  const h = harness();
  h.run("  keep the test findings  ");
  assert.deepEqual(h.sent, ["/compact keep the test findings"]);
});

test("headless forwards still send but skip the notice", () => {
  const h = harness();
  h.forward(undefined, undefined);
  h.flush();
  assert.deepEqual(h.sent, ["/compact"]);
  assert.deepEqual(h.notices, []);
});

test("the forward is deferred one tick so the cancelled pass finishes first", () => {
  const h = harness();
  h.forward(undefined, undefined);
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
