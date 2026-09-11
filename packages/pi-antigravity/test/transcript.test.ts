import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agyTurnTranscriptVerdict } from "../lib/tasks.ts";

for (const [label, response] of [
  ["ASCII", "x".repeat(70_000)],
  ["UTF-8", "完成🚀".repeat(20_000)],
]) {
  for (const ending of ["\n", "", '\n{"step_index":4,"type":"GENER']) {
    test(`transcript recovers a large ${label} response with ending ${JSON.stringify(ending)}`, async () => {
      const brainDir = await mkdtemp(path.join(tmpdir(), "agy-transcript-large-"));
      const logDir = path.join(brainDir, "conv", ".system_generated", "logs");
      await mkdir(logDir, { recursive: true });
      try {
        const prefix = JSON.stringify({ step_index: 2, type: "GENERIC", status: "RUNNING" });
        const final = JSON.stringify({
          step_index: 3,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: response,
        });
        assert.ok(Buffer.byteLength(final) > 65_536);
        await writeFile(path.join(logDir, "transcript_full.jsonl"), `${prefix}\n${final}${ending}`);
        assert.deepEqual(await agyTurnTranscriptVerdict("conv", [2], brainDir), {
          finished: true,
          response,
        });
        assert.deepEqual(await agyTurnTranscriptVerdict("conv", [3], brainDir), {
          finished: false,
        });
      } finally {
        await rm(brainDir, { recursive: true, force: true });
      }
    });
  }
}

test("transcript expansion remains bounded and can fall back to the compact transcript", async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), "agy-transcript-bound-"));
  const logDir = path.join(brainDir, "conv", ".system_generated", "logs");
  await mkdir(logDir, { recursive: true });
  try {
    const step = {
      step_index: 3,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "x".repeat(8 * 1024 * 1024),
    };
    await writeFile(path.join(logDir, "transcript_full.jsonl"), JSON.stringify(step));
    assert.equal(await agyTurnTranscriptVerdict("conv", [2], brainDir), undefined);
    await writeFile(
      path.join(logDir, "transcript.jsonl"),
      JSON.stringify({ ...step, content: "answer" }),
    );
    assert.deepEqual(await agyTurnTranscriptVerdict("conv", [2], brainDir), {
      finished: true,
      response: "answer",
    });
  } finally {
    await rm(brainDir, { recursive: true, force: true });
  }
});
