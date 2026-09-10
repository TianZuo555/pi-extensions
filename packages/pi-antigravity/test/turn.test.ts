import assert from "node:assert/strict";
import { test } from "node:test";
import { AgyTurnController } from "../lib/turn.ts";

test("turn exposes only one synthetic thought marker", () => {
  const controller = new AgyTurnController("use several tools");
  assert.equal(controller.claimThought(), true);
  assert.equal(controller.claimThought(), false);
});

test("turn usage subtracts the resumed conversation baseline", () => {
  const controller = new AgyTurnController("follow up", {
    input_tokens: 1_000,
    output_tokens: 100,
    thinking_tokens: 50,
    cache_read_tokens: 500,
    total_tokens: 1_100,
  });

  assert.deepEqual(
    controller.claimUsage(
      {
        input_tokens: 200,
        output_tokens: 20,
        thinking_tokens: 10,
        cache_read_tokens: 50,
        total_tokens: 220,
      },
      false,
    ),
    {
      input_tokens: 200,
      output_tokens: 20,
      thinking_tokens: 10,
      cache_read_tokens: 50,
      total_tokens: 220,
    },
  );

  assert.deepEqual(
    controller.claimUsage(
      {
        input_tokens: 1_250,
        output_tokens: 125,
        thinking_tokens: 62,
        cache_read_tokens: 570,
        total_tokens: 1_375,
      },
      true,
    ),
    {
      input_tokens: 50,
      output_tokens: 5,
      thinking_tokens: 2,
      cache_read_tokens: 20,
      total_tokens: 55,
    },
  );
});

test("turn usage treats a lower terminal counter as an agy reset", () => {
  const controller = new AgyTurnController("after internal compaction", {
    input_tokens: 10_000,
    output_tokens: 1_000,
    total_tokens: 11_000,
  });

  assert.deepEqual(
    controller.claimUsage(
      {
        input_tokens: 300,
        output_tokens: 40,
        total_tokens: 340,
      },
      true,
    ),
    {
      input_tokens: 300,
      output_tokens: 40,
      total_tokens: 340,
    },
  );
});

test("remainingResponseText tolerates trailing-newline drift between deltas and result", () => {
  // agy streams "…text.\n" as deltas but reports "…text." in result.response
  // (measured against agy 1.2.0), and a result can carry either the whole
  // turn or only its final answer. Neither may be dropped nor duplicated.
  const wholeTurn = new AgyTurnController("p");
  wholeTurn.recordEmittedText("Checking.\n");
  wholeTurn.recordEmittedText("All 15 tests pass.\n");
  assert.equal(wholeTurn.remainingResponseText("Checking.\nAll 15 tests pass."), "");

  const finalOnly = new AgyTurnController("p");
  finalOnly.recordEmittedText("Checking.\n");
  finalOnly.recordEmittedText("All 15 tests pass.\n");
  assert.equal(finalOnly.remainingResponseText("All 15 tests pass."), "");

  const resultNewline = new AgyTurnController("p");
  resultNewline.recordEmittedText("Checking.\n");
  resultNewline.recordEmittedText("All 15 tests pass.");
  assert.equal(resultNewline.remainingResponseText("All 15 tests pass.\n"), "");

  // A genuinely different final answer still survives (the missing-message bug).
  const distinct = new AgyTurnController("p");
  distinct.recordEmittedText("Checking.\n");
  assert.equal(
    distinct.remainingResponseText("### Merge summary\n\nDone."),
    "### Merge summary\n\nDone.",
  );

  // Plain continuations are still emitted as suffixes.
  const suffix = new AgyTurnController("p");
  suffix.recordEmittedText("Started");
  assert.equal(suffix.remainingResponseText("Started at :3000."), " at :3000.");
});
