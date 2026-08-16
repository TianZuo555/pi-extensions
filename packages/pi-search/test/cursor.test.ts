import assert from "node:assert/strict";
import { test } from "node:test";
import { createCursorStore } from "../lib/cursor.ts";

test("saves and serves a page", () => {
  const store = createCursorStore();
  const id = store.save("grep", ["a", "b"]);
  const page = store.take("grep", id);
  assert.deepEqual(page?.lines, ["a", "b"]);
});

test("a cursor is consumed once", () => {
  const store = createCursorStore();
  const id = store.save("grep", ["a"]);
  assert.notEqual(store.take("grep", id), undefined);
  assert.equal(store.take("grep", id), undefined);
});

test("a cursor cannot be replayed against another tool", () => {
  const store = createCursorStore();
  const id = store.save("grep", ["a"]);
  assert.equal(store.take("find", id), undefined);
  // The original owner can still claim it.
  assert.notEqual(store.take("grep", id), undefined);
});

test("unknown cursors return undefined", () => {
  const store = createCursorStore();
  assert.equal(store.take("grep", "grep_c999"), undefined);
});

test("ids are unique per save", () => {
  const store = createCursorStore();
  const ids = new Set([
    store.save("grep", ["a"]),
    store.save("grep", ["b"]),
    store.save("find", ["c"]),
  ]);
  assert.equal(ids.size, 3);
});

test("the store is bounded and evicts the oldest entry first", () => {
  const store = createCursorStore(2);
  const first = store.save("grep", ["1"]);
  const second = store.save("grep", ["2"]);
  const third = store.save("grep", ["3"]);

  assert.equal(store.size, 2);
  assert.equal(store.take("grep", first), undefined);
  assert.notEqual(store.take("grep", second), undefined);
  assert.notEqual(store.take("grep", third), undefined);
});
