import assert from "node:assert/strict";
import test from "node:test";
import { wrapperToolActiveAfterModelSwitch } from "../lib/wrapper-activation.ts";

const WRAPPER = "antigravity";
const BASE = ["read", "bash", WRAPPER];

test("adds the wrapper when an antigravity model is selected", () => {
  const next = wrapperToolActiveAfterModelSwitch(
    ["read", "bash"],
    WRAPPER,
    "antigravity",
    "antigravity",
  );
  assert.deepEqual(next, ["read", "bash", WRAPPER]);
});

test("removes the wrapper for every other provider", () => {
  const next = wrapperToolActiveAfterModelSwitch(BASE, WRAPPER, "openrouter", "antigravity");
  assert.deepEqual(next, ["read", "bash"]);
  const noModel = wrapperToolActiveAfterModelSwitch(BASE, WRAPPER, undefined, "antigravity");
  assert.deepEqual(noModel, ["read", "bash"]);
});

test("returns undefined when activation already matches", () => {
  // Already active + agy model: no list churn, other tools untouched.
  assert.equal(
    wrapperToolActiveAfterModelSwitch(BASE, WRAPPER, "antigravity", "antigravity"),
    undefined,
  );
  // Already inactive + non-agy model.
  assert.equal(
    wrapperToolActiveAfterModelSwitch(["read"], WRAPPER, "anthropic", "antigravity"),
    undefined,
  );
});

test("preserves surrounding tool order on removal", () => {
  const next = wrapperToolActiveAfterModelSwitch(
    ["read", WRAPPER, "bash", "grep"],
    WRAPPER,
    "openai",
    "antigravity",
  );
  assert.deepEqual(next, ["read", "bash", "grep"]);
});
