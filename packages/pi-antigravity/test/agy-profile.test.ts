import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgyAgents, readAgyProcessProfile } from "../lib/agy-profile.ts";

test("readAgyProcessProfile validates agent and execution mode", () => {
  assert.deepEqual(
    readAgyProcessProfile({
      PI_ANTIGRAVITY_AGENT: " reviewer ",
      PI_ANTIGRAVITY_MODE: "plan",
    }),
    { agent: "reviewer", mode: "plan" },
  );
  assert.deepEqual(readAgyProcessProfile({}), {});
  assert.throws(
    () => readAgyProcessProfile({ PI_ANTIGRAVITY_MODE: "danger" }),
    /plan.*accept-edits/,
  );
  assert.throws(() => readAgyProcessProfile({ PI_ANTIGRAVITY_AGENT: "  " }), /must not be empty/);
  assert.throws(() => readAgyProcessProfile({ PI_ANTIGRAVITY_AGENT: "bad\0name" }), /NUL/);
  assert.throws(
    () => readAgyProcessProfile({ PI_ANTIGRAVITY_AGENT: "bad\nname" }),
    /control characters/,
  );
});

test("parseAgyAgents tolerates empty, tabular, and bullet output", () => {
  assert.deepEqual(parseAgyAgents(""), []);
  assert.deepEqual(
    parseAgyAgents("Available agents:\nreviewer  Reviews code\n- planner\nreviewer\tduplicate"),
    ["reviewer", "planner"],
  );
});
