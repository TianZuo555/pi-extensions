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

test("computeRate ignores samples older than the window", () => {
  const samples = [
    { t: 0, tokens: 5000 },
    { t: 1000, tokens: 5000 },
    { t: 10_000, tokens: 4 },
    { t: 10_100, tokens: 4 },
  ];
  const stream = {
    samples,
    startedAt: 0,
    firstTokenAt: 0,
    estimatedTokens: 10_008,
    streaming: true,
  };

  // Window is [5100, 10100]: only the two tiny samples count. 8 tokens over
  // a span clamped to MIN_SPAN_MS (250ms) → exactly 32 tok/s, not ~991 as it
  // would be if the stale 10k samples leaked into the window.
  const rate = computeRate(stream, 10_100);
  assert.equal(rate, 32);
});

test("sliding-window samples stay bounded across a long stream", async () => {
  const runtime = createTokenSpeedRuntime();
  const service = runtime.runSync(TokenSpeedRuntime);

  await runTokenSpeed(runtime, service.setMode("live"));
  await runTokenSpeed(runtime, service.beginStream(0));

  // 60s of streaming, one delta every 50ms — 1200 deltas, far more than the
  // 5s window can hold. Regression guard: the old implementation never
  // advanced its head index, so the buffer grew without bound.
  for (let t = 50; t <= 60_000; t += 50) {
    await runTokenSpeed(runtime, service.recordDelta("abcd", t));
  }

  const count = await runTokenSpeed(runtime, service.getWindowSampleCount);
  // Exactly one window: samples at t ∈ [55000, 60000] every 50ms = 101.
  assert.equal(count, 101, `expected exactly one 5s window of samples, got ${count}`);

  await runtime.dispose();
});
