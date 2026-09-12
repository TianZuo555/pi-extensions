import assert from "node:assert/strict";
import { test } from "node:test";
import { DevinReplayStore, MAX_RECORDED_OUTPUT_CHARS, MAX_RECORDED_TOOLS } from "../lib/replay.ts";

test("recorded output is capped so pi's session file cannot grow unbounded", () => {
  const store = new DevinReplayStore();
  const huge = "x".repeat(MAX_RECORDED_OUTPUT_CHARS + 5_000);
  store.record("call-1", { title: "Ran seq", output: huge });
  const recorded = store.take("call-1");
  assert.equal(recorded?.output?.length, MAX_RECORDED_OUTPUT_CHARS);
  // The cap must not allocate a new string for outputs already under it.
  store.record("call-2", { title: "small", output: "ok" });
  assert.equal(store.take("call-2")?.output, "ok");
});

test("unconsumed records are evicted oldest-first", () => {
  const store = new DevinReplayStore();
  for (let i = 0; i < MAX_RECORDED_TOOLS + 3; i++) {
    store.record(`call-${i}`, { title: `tool ${i}` });
  }
  assert.equal(store.size, MAX_RECORDED_TOOLS);
  assert.equal(store.take("call-0"), undefined, "oldest record was evicted");
  assert.equal(
    store.take(`call-${MAX_RECORDED_TOOLS + 2}`)?.title,
    `tool ${MAX_RECORDED_TOOLS + 2}`,
  );
});

test("take consumes a record exactly once", () => {
  const store = new DevinReplayStore();
  store.record("call-1", { title: "Read file" });
  assert.equal(store.take("call-1")?.title, "Read file");
  assert.equal(store.take("call-1"), undefined);
  assert.equal(store.size, 0);
});
