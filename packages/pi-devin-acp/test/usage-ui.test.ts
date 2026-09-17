import assert from "node:assert/strict";
import { test } from "node:test";
import type { DevinStateSnapshot } from "../src/runtime.ts";
import type { DevinUsage } from "../src/turn.ts";
import { formatDevinUsageReport } from "../src/usage-ui.ts";

function snapshot(partial: Partial<DevinStateSnapshot>): DevinStateSnapshot {
  return {
    sessionId: "sess-1",
    title: undefined,
    model: "swe-2",
    concreteModel: "swe-2-max",
    modeId: "accept-edits",
    cwd: "/tmp",
    turns: 1,
    contextTokens: undefined,
    contextSize: undefined,
    usage: undefined,
    configOptions: undefined,
    availableCommands: undefined,
    lastTurnStats: undefined,
    liveOps: [],
    retry: undefined,
    client: { spawned: 1, requestsSent: 1, notificationsReceived: 5 },
    ...partial,
  };
}

test("formatDevinUsageReport is undefined before any usage data", () => {
  assert.equal(formatDevinUsageReport(snapshot({})), undefined);
});

test("formatDevinUsageReport renders the context bar and counter rows", () => {
  const usage: DevinUsage = {
    contextUsed: 13100,
    contextSize: 262000,
    inputTokens: 12352,
    outputTokens: 38,
    cachedReadTokens: 4796,
    cachedWriteTokens: 0,
    totalCreditCost: 0.05,
    totalAcuCost: 0.02,
    cost: { amount: 0.0312, currency: "USD" },
  };
  const report = formatDevinUsageReport(
    snapshot({
      usage,
      title: "Fix the flaky test",
      lastTurnStats: {
        modelLabel: "SWE-2 Max",
        tokensPerSec: 7.73,
        ttftMs: 4915,
        totalTimeMs: 4915,
        toolCalls: 3,
        commandsRun: 2,
        filesChanged: 1,
        creditCost: 0.01,
        acuCost: 0.004,
      },
    }),
  );
  assert.ok(report);
  assert.match(report, /^Devin · SWE-2 Max — Fix the flaky test/m);
  assert.match(report, /Context:\s+\[█+░+\] 5% used · 13,100 \/ 262,000 tokens/);
  assert.match(report, /Input:\s+12,352 tokens/);
  assert.match(report, /Cached read:\s+4,796 tokens/);
  assert.match(report, /Credits:\s+0\.05/);
  assert.match(report, /ACUs:\s+0\.02/);
  assert.match(report, /Cost:\s+\$0\.0312/);
  assert.match(report, /Last turn/);
  assert.match(report, /Speed:\s+7\.7 tok\/s · ttft 4\.9s · total 4\.9s/);
  assert.match(report, /Calls:\s+3 tool calls · 2 commands · 1 files changed/);
});

test("formatDevinUsageReport renders server-grouped dimensions", () => {
  const dims = [
    {
      uid: "agent_messages",
      groupTitle: "Response Statistics",
      label: "Agent messages",
      kind: {
        type: "cumulativeMetric",
        value: 1,
        prefix: "",
        tail: " message",
        pluralTail: " messages",
      },
    },
    {
      uid: "model",
      groupTitle: "Response Statistics",
      label: "Model",
      kind: { type: "metric", value: "SWE-2 Max" },
    },
    {
      uid: "input_tokens",
      groupTitle: "Token Usage",
      label: "Input tokens",
      kind: {
        type: "cumulativeMetric",
        value: 12352,
        prefix: "",
        tail: " token",
        pluralTail: " tokens",
      },
    },
  ];
  const report = formatDevinUsageReport(
    snapshot({
      usage: { contextUsed: 100, contextSize: 1000, dimensions: dims },
      lastTurnStats: { dimensions: dims },
    }),
  );
  assert.ok(report);
  // Consecutive dims sharing a groupTitle collapse into one section.
  assert.match(
    report,
    /Response Statistics\n {2}Agent messages: {2,}1 message\n {2}Model: {2,}SWE-2 Max/,
  );
  assert.match(report, /Token Usage\n {2}Input tokens: {2,}12,352 tokens/);
  assert.match(report, /Last turn\n {2}Agent messages: {2,}1 message/);
  // Counters are not duplicated when dimensions carry them.
  assert.equal((report.match(/Input tokens:/g) ?? []).length, 2);
  assert.doesNotMatch(report, / {2}Input: {2,}/);
});
