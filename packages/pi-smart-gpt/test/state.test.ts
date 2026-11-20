import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProbeRun } from "../lib/magpie.ts";
import {
  appendRun,
  formatHistory,
  formatRun,
  lastRuns,
  medianOf,
  readRuns,
  runsFile,
  stateDir,
  streakOf,
} from "../lib/state.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-smart-gpt-"));
}

function run(at: string, answer: number | undefined, reasoning?: number): ProbeRun {
  return {
    at,
    account: "someone@example.com",
    model: "codex/gpt-6.2-sol",
    effort: "high",
    verdict: answer === 21 ? "ok" : answer === 29 ? "blind" : "wrong",
    ...(answer === undefined ? {} : { answer }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    latencyMs: 22_000,
  };
}

test("stateDir honours PI_SMART_STATE_DIR and defaults under ~/.pi", () => {
  assert.equal(stateDir({ PI_SMART_STATE_DIR: "/tmp/x" }), "/tmp/x");
  assert.equal(stateDir({}), path.join(os.homedir(), ".pi", "smart-gpt"));
});

test("runs round-trip through runs.jsonl", () => {
  const dir = tempDir();
  assert.deepEqual(readRuns(dir), []);
  appendRun(dir, run("2026-11-19T09:00:00.000Z", 21, 400));
  appendRun(dir, run("2026-11-19T11:00:00.000Z", 29, 120));
  assert.equal(fs.existsSync(runsFile(dir)), true);
  const runs = readRuns(dir);
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.answer, 21);
  assert.equal(runs[1]!.verdict, "blind");
});

test("readRuns skips a half-written line", () => {
  const dir = tempDir();
  appendRun(dir, run("2026-11-19T09:00:00.000Z", 21));
  fs.appendFileSync(runsFile(dir), '{"at":"2026-11-19T10:00:00.000Z","acc');
  assert.equal(readRuns(dir).length, 1);
});

test("lastRuns filters by account and keeps the newest", () => {
  const dir = tempDir();
  appendRun(dir, run("2026-11-19T09:00:00.000Z", 21));
  appendRun(dir, { ...run("2026-11-19T11:00:00.000Z", 21), account: "other@example.com" });
  appendRun(dir, run("2026-11-19T13:00:00.000Z", 21));
  assert.equal(lastRuns(dir, 10).length, 3);
  const mine = lastRuns(dir, 10, "someone@example.com");
  assert.equal(mine.length, 2);
  assert.equal(mine.at(-1)!.at, "2026-11-19T13:00:00.000Z");
});

test("medianOf reads an even count as the middle two", () => {
  assert.equal(medianOf([]), undefined);
  assert.equal(medianOf([400]), 400);
  assert.equal(medianOf([500, 300, 400]), 400);
  assert.equal(medianOf([300, 500]), 400);
});

test("streakOf counts the runs since the last 21", () => {
  assert.equal(streakOf([run("a", 21), run("b", 21)]), 0);
  assert.equal(streakOf([run("a", 21), run("b", 29)]), 1);
  assert.equal(streakOf([run("a", 29), run("b", 28), run("c", 29)]), 3);
});

test("formatRun keeps one line and names the reasoning tokens", () => {
  const line = formatRun(run("2026-11-19T09:00:00.000Z", 21, 400));
  assert.equal(line.includes("\n"), false);
  assert.equal(line.includes("400"), true);
  assert.equal(line.includes("ok"), true);
});

test("formatHistory says so when there are no runs", () => {
  assert.equal(formatHistory([], "title").includes("no runs yet"), true);
});

test("formatHistory reports the median and a run of misses", () => {
  const history = formatHistory(
    [run("2026-11-19T09:00:00.000Z", 21, 400), run("2026-11-19T11:00:00.000Z", 29, 120)],
    "title",
  );
  assert.equal(history.includes("2 runs · 1 answered 21"), true);
  assert.equal(history.includes("median reasoning 260 tok"), true);
  assert.equal(history.includes("the last 1 runs"), false);
});
