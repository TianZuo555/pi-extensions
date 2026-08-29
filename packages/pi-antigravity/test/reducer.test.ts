import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgyLine } from "../lib/events.ts";
import { applyEvent, newTurnOutcome, reduceAgyStream } from "../lib/reducer.ts";
import { CONVERSATION_ID, OK_CAPTURE, REAL_CAPTURE } from "./fixtures.ts";

test("parseAgyLine recognizes init/step/result and tolerates junk", () => {
  const init = parseAgyLine(`{"event":"init","conversation_id":"x","init":{"cwd":"/tmp"}}`);
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

  const types = outcome.activities.map((a) => a.type);
  assert.ok(types.includes("tool_start"));
  assert.ok(types.includes("tool_done"));
  assert.ok(types.includes("tool_error"));
  assert.ok(types.includes("result"));

  const start = outcome.activities.find((a) => a.type === "tool_start");
  assert.ok(start && start.type === "tool_start" && start.name === "view_file");
  assert.equal(start.stepId, 3);
  assert.deepEqual(start.args, { AbsolutePath: "/tmp/notes/todo.md" });

  const done = outcome.activities.find((a) => a.type === "tool_done");
  assert.ok(done && done.type === "tool_done" && done.name === "view_file");
  assert.equal(done.stepId, 3);
  assert.ok(typeof done.durationSeconds === "number");
  assert.equal(done.output, "55 lines, 2955 bytes");

  const error = outcome.activities.find((a) => a.type === "tool_error");
  assert.ok(error && error.type === "tool_error" && error.name === "run_command");
  assert.ok(error.message.includes("permission check failed"));
});

test("reducer reads tool output from tool_info when top-level output is absent", () => {
  const outcome = reduceAgyStream(
    [
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "c-info-1",
          step_index: 0,
          state: "DONE",
          step_type: "tool",
          tool_name: "grep_search",
          duration_seconds: 0.05,
          tool_info: { name: "grep_search", parameters: {}, output: "./a.ts: hi" },
        },
      }),
    ].join("\n"),
  );
  const done = outcome.activities.find((a) => a.type === "tool_done");
  assert.ok(done && done.type === "tool_done");
  assert.equal(done.output, "./a.ts: hi");
});

test("reducer folds a successful turn", () => {
  const outcome = reduceAgyStream(OK_CAPTURE);
  assert.equal(outcome.status, "OK");
  assert.equal(outcome.response, "Hello from agy!");
  assert.equal(outcome.conversationId, "c-ok-1");
  assert.equal(outcome.usage?.total_tokens, 120);
  assert.ok(outcome.activities.length >= 2);

  const text = outcome.activities
    .filter((a) => a.type === "text")
    .map((a) => (a.type === "text" ? a.delta : ""))
    .join("");
  assert.equal(text, "Hello from agy!");
});

test("reducer normalizes the SUCCESS result status of agy >= 1.1.22", () => {
  const outcome = reduceAgyStream(
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "hi" } }),
  );
  assert.equal(outcome.status, "OK");
  assert.equal(outcome.response, "hi");
});

test("reducer fails closed on non-success result statuses", () => {
  // agy ships FAILURE, CANCELLED, and TIMEOUT alongside ERROR. None of them
  // may be rendered as a normal answer, even when response text is present.
  for (const status of ["ERROR", "FAILURE", "CANCELLED", "TIMEOUT", "WAT"]) {
    const outcome = reduceAgyStream(
      JSON.stringify({ event: "result", result: { status, response: "partial answer" } }),
    );
    assert.equal(outcome.status, "ERROR", `expected ${status} to fail the turn`);
  }
});

test("reducer emits a thought marker for response steps that burned thinking tokens", () => {
  const outcome = reduceAgyStream(
    [
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "answer",
          duration_seconds: 3.4,
          usage: { input_tokens: 100, output_tokens: 50, thinking_tokens: 289, total_tokens: 150 },
        },
      }),
    ].join("\n"),
  );
  const thought = outcome.activities.find((a) => a.type === "thought");
  assert.ok(thought && thought.type === "thought");
  assert.equal(thought.tokens, 289);
  assert.equal(thought.durationSeconds, 3.4);
});

test("reducer suppresses incidental tiny thinking-token traces", () => {
  const outcome = reduceAgyStream(
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        duration_seconds: 1.2,
        usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 40, total_tokens: 120 },
      },
    }),
  );
  assert.ok(!outcome.activities.some((a) => a.type === "thought"));
});

test("reducer emits no thought marker without thinking tokens", () => {
  const outcome = reduceAgyStream(
    [
      // ACTIVE step with usage only — no DONE, no duration yet.
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: "partial",
          usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 5, total_tokens: 110 },
        },
      }),
      // DONE with zero thinking tokens (non-thinking model).
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          duration_seconds: 2,
          usage: { input_tokens: 100, output_tokens: 50, thinking_tokens: 0, total_tokens: 150 },
        },
      }),
    ].join("\n"),
  );
  assert.ok(!outcome.activities.some((a) => a.type === "thought"));
});

test("applyEvent streams activity events incrementally", () => {
  const outcome = newTurnOutcome();
  const seen = [];
  for (const line of OK_CAPTURE.split("\n")) {
    seen.push(...applyEvent(outcome, parseAgyLine(line)));
  }
  assert.deepEqual(seen, outcome.activities);
  assert.ok(seen.length > 0);
});
