import assert from "node:assert/strict";
import { test } from "node:test";
import { createCursorStore } from "../lib/cursor.ts";

test("saves and serves a page for the same query", () => {
  const store = createCursorStore();
  const id = store.save("grep", "needle", ["a", "b"]);
  const page = store.take("grep", "needle", id);
  assert.notEqual(page, undefined);
  assert.equal(page?.status, "ok");
  if (page?.status === "ok") assert.deepEqual(page.lines, ["a", "b"]);
});

test("a cursor is consumed once", () => {
  const store = createCursorStore();
  const id = store.save("grep", "needle", ["a"]);
  assert.notEqual(store.take("grep", "needle", id), undefined);
  assert.equal(store.take("grep", "needle", id), undefined);
});

test("a cursor cannot be replayed against another tool", () => {
  const store = createCursorStore();
  const id = store.save("grep", "needle", ["a"]);
  assert.equal(store.take("find", "needle", id), undefined);
  // The original owner can still claim it.
  assert.notEqual(store.take("grep", "needle", id), undefined);
});

test("a query mismatch keeps the cursor for its original query", () => {
  const store = createCursorStore();
  const id = store.save("grep", "needle", ["a"]);
  const mismatch = store.take("grep", "other", id);
  assert.deepEqual(mismatch, { status: "query-mismatch" });
  // Not consumed: the original query can still page it.
  const page = store.take("grep", "needle", id);
  assert.equal(page?.status, "ok");
});

test("unknown cursors return undefined", () => {
  const store = createCursorStore();
  assert.equal(store.take("grep", "needle", "grep_c999"), undefined);
});

test("ids are unique per save", () => {
  const store = createCursorStore();
  const ids = new Set([
    store.save("grep", "needle", ["a"]),
    store.save("grep", "needle", ["b"]),
    store.save("find", "file", ["c"]),
  ]);
  assert.equal(ids.size, 3);
});

test("the store is bounded and evicts the oldest entry first", () => {
  const store = createCursorStore(2);
  const first = store.save("grep", "needle", ["1"]);
  const second = store.save("grep", "needle", ["2"]);
  const third = store.save("grep", "needle", ["3"]);

  assert.equal(store.size, 2);
  assert.equal(store.take("grep", "needle", first), undefined);
  assert.notEqual(store.take("grep", "needle", second), undefined);
  assert.notEqual(store.take("grep", "needle", third), undefined);
});
