import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgyLine } from "../lib/events.ts";
import { applyEvent, newTurnOutcome, reduceAgyStream } from "../lib/reducer.ts";
import { CONVERSATION_ID, OK_CAPTURE, REAL_CAPTURE } from "./fixtures.ts";

test("parseAgyLine recognizes init/step/result and tolerates junk", () => {
  const init = parseAgyLine(
    `{"event":"init","conversation_id":"x","init":{"cwd":"/tmp"}}`,
  );
  assert.equal(init.kind, "init");
  assert.ok(init.kind === "init" && init.conversationId === "x");

  const step = parseAgyLine(
    `{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"checkpoint"}}`,
  );
  assert.equal(step.kind, "step");

  const result = parseAgyLine(`{"event":"result","result":{"status":"OK"}}`);
  assert.equal(result.kind, "result");

  assert.equal(parseAgyLine("").kind, "unknown");
  assert.equal(parseAgyLine("not json").kind, "unknown");
  assert.equal(parseAgyLine(`{"event":"future_thing"}`).kind, "unknown");
});

test("reducer folds the real error capture", () => {
  const outcome = reduceAgyStream(REAL_CAPTURE);
  assert.equal(outcome.finished, true);
  assert.equal(outcome.conversationId, CONVERSATION_ID);
  assert.equal(outcome.status, "ERROR");
  assert.ok(outcome.error?.includes("permission check failed"));
  assert.equal(outcome.usage?.input_tokens, 44909);
  assert.equal(outcome.usage?.total_tokens, 45519);
  assert.ok(outcome.toolLines.some((l) => l.startsWith("⏺ view_file")));
  assert.ok(outcome.toolLines.some((l) => l.startsWith("✓ view_file")));
  assert.ok(outcome.toolLines.some((l) => l.startsWith("✗ run_command")));
});

test("reducer folds a successful turn", () => {
  const outcome = reduceAgyStream(OK_CAPTURE);
  assert.equal(outcome.status, "OK");
  assert.equal(outcome.response, "Hello from agy!");
  assert.equal(outcome.conversationId, "c-ok-1");
  assert.equal(outcome.usage?.total_tokens, 120);
  assert.ok(outcome.toolLines.length >= 2);
});

test("applyEvent streams activity lines incrementally", () => {
  const outcome = newTurnOutcome();
  const seen: string[] = [];
  for (const line of OK_CAPTURE.split("\n")) {
    seen.push(...applyEvent(outcome, parseAgyLine(line)));
  }
  assert.deepEqual(seen, outcome.toolLines);
  assert.ok(seen.length > 0);
});
