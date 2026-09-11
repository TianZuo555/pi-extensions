import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgyRelayedInstructions, piSystemInstructionsPrompt } from "../lib/prompt.ts";

const docs = { readme: "/pi/README.md", docs: "/pi/docs", examples: "/pi/examples" };

test("the relay is exactly the pi documentation block", () => {
  const relay = buildAgyRelayedInstructions(docs);
  assert.match(relay, /Main documentation: \/pi\/README\.md/);
  assert.match(relay, /Additional docs: \/pi\/docs/);
  assert.match(relay, /Examples: \/pi\/examples/);
  // Nothing else: no skills catalog, no project context, no custom prompt.
  assert.ok(!relay.includes("available_skills"));
  assert.ok(!relay.includes("project_instructions"));
  assert.ok(!relay.includes("Current working directory"));
});

test("the envelope still explains the relay to agy", () => {
  const relay = piSystemInstructionsPrompt(buildAgyRelayedInstructions(docs));
  assert.match(relay, /## Current Pi instructions/);
  assert.match(relay, /Pi documentation/);
  assert.match(relay, /## End of Pi instructions/);
});
