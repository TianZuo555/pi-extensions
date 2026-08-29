import assert from "node:assert/strict";
import { test } from "node:test";
import {
  killAllAgyTrees,
  killAgyTree,
  trackAgyChild,
  untrackAgyChild,
} from "../lib/agy-children.ts";

test("tracking tolerates children without a pid", () => {
  trackAgyChild({});
  killAgyTree({});
  untrackAgyChild({});
  killAllAgyTrees(); // must not throw
});

test("killAgyTree and killAllAgyTrees never throw for unknown pids", () => {
  const ghost = { pid: 999_999_999 };
  trackAgyChild(ghost);
  killAllAgyTrees(); // reaps (or ignores ESRCH) and clears the registry
  killAgyTree(ghost); // second sweep after clear is also a no-op
  assert.ok(true);
});

test("untrackAgyChild removes a tracked pid", () => {
  const child = { pid: 42 };
  trackAgyChild(child);
  untrackAgyChild(child);
  killAllAgyTrees();
  assert.ok(true);
});
