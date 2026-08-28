import assert from "node:assert/strict";
import test from "node:test";
import {
  computeAverageRate,
  computeRate,
  createTokenSpeedRuntime,
  formatCount,
  formatDuration,
  formatRate,
  runTokenSpeed,
  TokenSpeedRuntime,
} from "../src/runtime.ts";

test("TokenSpeed formatting helpers", () => {
  assert.equal(formatCount(1500), "1.5k");
  assert.equal(formatCount(2500000), "2.5M");
  assert.equal(formatCount(42), "42");

  assert.equal(formatRate(125.4), "125");
  assert.equal(formatRate(45.67), "45.7");

  assert.equal(formatDuration(500), "500ms");
  assert.equal(formatDuration(2500), "2.5s");
});

test("TokenSpeed computeRate and computeAverageRate", () => {
  const stream = {
    samples: [
      { t: 1000, tokens: 10 },
      { t: 2000, tokens: 20 },
    ],
    head: 0,
    startedAt: 1000,
    firstTokenAt: 1000,
    estimatedTokens: 30,
    streaming: true,
  };

  const rate = computeRate(stream, 3000);
  assert.ok(rate > 0);

  const avg = computeAverageRate(stream, 30, 3000);
  assert.equal(Math.round(avg), 15);
});

test("TokenSpeedRuntime stream lifecycle and mode cycling", async () => {
  const runtime = createTokenSpeedRuntime();
  const service = runtime.runSync(TokenSpeedRuntime);

  await runTokenSpeed(runtime, service.setMode("live"));
  const mode = await runTokenSpeed(runtime, service.getMode);
  assert.equal(mode, "live");

  await runTokenSpeed(runtime, service.beginStream(1000));
  // First delta after stream start renders immediately
  const d1 = await runTokenSpeed(runtime, service.recordDelta("hello world", 1050));
  assert.equal(d1.shouldRender, true);
  assert.match(d1.statusText ?? "", /⚡/);

  // Rapid delta < 100ms throttled
  const d2 = await runTokenSpeed(runtime, service.recordDelta(" foo", 1080));
  assert.equal(d2.shouldRender, false);

  // Delta after 100ms interval renders
  const d3 = await runTokenSpeed(runtime, service.recordDelta(" more text streaming in", 1200));
  assert.equal(d3.shouldRender, true);
  assert.match(d3.statusText ?? "", /⚡/);

  const end = await runTokenSpeed(runtime, service.endStream(25, 2000));
  assert.equal(end.shouldRender, true);
  assert.match(end.summary, /25 tok/);

  const last = await runTokenSpeed(runtime, service.getLastSummary);
  assert.equal(last, end.summary);

  await runtime.dispose();
});
