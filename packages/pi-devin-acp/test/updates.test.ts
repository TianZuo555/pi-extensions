import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  acpUpdateToActivities,
  agentStoppedToActivity,
  connectionRetryToActivity,
  turnStatsToDimensions,
} from "../src/updates.ts";

test("agent_message_chunk maps to text delta with messageId", () => {
  const update = {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Hello " },
    messageId: "m1",
  } as unknown as SessionUpdate;
  assert.deepEqual(acpUpdateToActivities(update), [
    { type: "text", delta: "Hello ", messageId: "m1" },
  ]);
});

test("agent_thought_chunk maps to thought delta", () => {
  const update = {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "thinking…" },
  } as unknown as SessionUpdate;
  assert.deepEqual(acpUpdateToActivities(update), [
    { type: "thought", delta: "thinking…", messageId: undefined },
  ]);
});

test("tool_call maps to tool_start with normalized view", () => {
  const update = {
    sessionUpdate: "tool_call",
    toolCallId: "write_1",
    title: "Wrote /tmp/x.txt",
    kind: "edit",
    status: "in_progress",
    content: [{ type: "diff", path: "/tmp/x.txt", newText: "hello" }],
    locations: [{ path: "/tmp/x.txt" }],
    rawInput: { file_path: "/tmp/x.txt" },
    _meta: { "cognition.ai/inferenceToolName": "write" },
  } as unknown as SessionUpdate;
  const [activity] = acpUpdateToActivities(update);
  assert.equal(activity.type, "tool_start");
  if (activity.type !== "tool_start") return;
  assert.equal(activity.view.id, "write_1");
  assert.equal(activity.view.tool, "write");
  assert.equal(activity.view.kind, "edit");
  assert.equal(activity.view.diff?.[0].path, "/tmp/x.txt");
  assert.deepEqual(activity.view.locations, ["/tmp/x.txt"]);
});

test("tool_call_update merges content and status", () => {
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId: "read_0",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "file body" } }],
    _meta: { "cognition.ai/inferenceToolName": "read" },
  } as unknown as SessionUpdate;
  const [activity] = acpUpdateToActivities(update);
  assert.equal(activity.type, "tool_update");
  if (activity.type !== "tool_update") return;
  assert.equal(activity.view.status, "completed");
  assert.equal(activity.view.output, "file body");
});

test("usage_update maps _meta token counters and context occupancy", () => {
  const update = {
    sessionUpdate: "usage_update",
    used: 13460,
    size: 262000,
    _meta: {
      "cognition.ai/inputTokens": 13336,
      "cognition.ai/outputTokens": 13,
      "cognition.ai/cachedReadTokens": 13322,
    },
  } as unknown as SessionUpdate;
  assert.deepEqual(acpUpdateToActivities(update), [
    {
      type: "usage",
      usage: {
        contextUsed: 13460,
        contextSize: 262000,
        inputTokens: 13336,
        outputTokens: 13,
        cachedReadTokens: 13322,
        cachedWriteTokens: undefined,
        totalCreditCost: undefined,
        totalAcuCost: undefined,
        cost: undefined,
        dimensions: undefined,
      },
    },
  ]);
});

test("usage_update maps billed totals, spec cost, and response dimensions", () => {
  const update = {
    sessionUpdate: "usage_update",
    used: 13460,
    size: 262000,
    cost: { amount: 0.0312, currency: "USD" },
    _meta: {
      "cognition.ai/inputTokens": 13336,
      "cognition.ai/outputTokens": 13,
      "cognition.ai/cachedReadTokens": 13322,
      "cognition.ai/cachedWriteTokens": 950,
      "cognition.ai/totalCreditCost": 0.05,
      "cognition.ai/totalAcuCost": 0.02,
      "cognition.ai/responseDimensions": [
        // usage_update _meta serializes dims with internally-tagged kinds.
        {
          uid: "input_tokens",
          group_title: "Token Usage",
          kind: {
            CumulativeMetric: {
              label: "Input tokens",
              value: 13336,
              prefix: "",
              tail: " token",
              plural_tail: " tokens",
            },
          },
        },
        {
          uid: "model",
          group_title: "Response Statistics",
          kind: { Metric: { label: "Model", value: "SWE-2 Max" } },
        },
        "junk",
      ],
    },
  } as unknown as SessionUpdate;
  const [activity] = acpUpdateToActivities(update);
  assert.equal(activity.type, "usage");
  if (activity.type !== "usage") return;
  assert.equal(activity.usage.cachedWriteTokens, 950);
  assert.equal(activity.usage.totalCreditCost, 0.05);
  assert.equal(activity.usage.totalAcuCost, 0.02);
  assert.deepEqual(activity.usage.cost, { amount: 0.0312, currency: "USD" });
  assert.equal(activity.usage.dimensions?.length, 2, "non-object dims are dropped");
  const [tokens, model] = activity.usage.dimensions ?? [];
  assert.equal(tokens?.label, "Input tokens");
  assert.equal(tokens?.groupTitle, "Token Usage");
  assert.equal(tokens?.kind?.type, "cumulativeMetric");
  assert.equal(tokens?.kind?.value, 13336);
  assert.equal(tokens?.kind?.pluralTail, " tokens");
  assert.equal(model?.label, "Model");
  assert.equal(model?.kind?.type, "metric");
  assert.equal(model?.kind?.value, "SWE-2 Max");
});

test("session_info_update and mode updates map to state activities", () => {
  const info = {
    sessionUpdate: "session_info_update",
    title: "My task",
  } as unknown as SessionUpdate;
  assert.deepEqual(acpUpdateToActivities(info), [{ type: "title", title: "My task" }]);
  const mode = {
    sessionUpdate: "current_mode_update",
    currentModeId: "plan",
  } as unknown as SessionUpdate;
  assert.deepEqual(acpUpdateToActivities(mode), [{ type: "mode", modeId: "plan" }]);
});

test("plan updates map to plan activity", () => {
  const update = {
    sessionUpdate: "plan",
    entries: [
      { content: "Step one", status: "completed" },
      { content: "Step two", status: "in_progress" },
    ],
  } as unknown as SessionUpdate;
  const [activity] = acpUpdateToActivities(update);
  assert.equal(activity.type, "plan");
  if (activity.type !== "plan") return;
  assert.equal(activity.entries.length, 2);
  assert.equal(activity.entries[1].status, "in_progress");
});

test("user_message_chunk and unknown updates are ignored", () => {
  const user = {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "echo" },
  } as unknown as SessionUpdate;
  assert.deepEqual(acpUpdateToActivities(user), []);
});

test("agentStoppedToActivity parses _cognition.ai/agent_stopped stats", () => {
  const activity = agentStoppedToActivity({
    cause: "end_turn",
    stats: {
      toolCalls: 6,
      filesChanged: 1,
      inputTokens: 14023,
      outputTokens: 18,
      ttftMs: 299,
      tokensPerSec: 22.5,
      modelLabel: "Claude Opus 5 Max",
      creditCost: 0.05,
      acuCost: 0.02,
      responseDimensions: [
        {
          uid: "model",
          groupTitle: "Response Statistics",
          label: "Model",
          kind: { type: "metric", value: "Claude Opus 5 Max" },
        },
      ],
    },
  });
  assert.equal(activity?.type, "stopped");
  if (activity?.type !== "stopped") return;
  assert.equal(activity.stats.tokensPerSec, 22.5);
  assert.equal(activity.stats.inputTokens, 14023);
  assert.equal(activity.stats.creditCost, 0.05);
  assert.equal(activity.stats.acuCost, 0.02);
  assert.equal(activity.stats.dimensions?.[0].label, "Model");
  assert.equal(agentStoppedToActivity("junk"), undefined);
});

test("connectionRetryToActivity parses _cognition.ai/connection_retry", () => {
  assert.deepEqual(
    connectionRetryToActivity({
      sessionId: "s1",
      attempt: 4,
      maxAttempts: 5,
      isStreamRetry: false,
    }),
    { type: "retry", attempt: 4, maxAttempts: 5, isStreamRetry: false },
  );
  assert.deepEqual(connectionRetryToActivity({ attempt: 2, isStreamRetry: true }), {
    type: "retry",
    attempt: 2,
    maxAttempts: undefined,
    isStreamRetry: true,
  });
});

test("connectionRetryToActivity ignores payloads without a numeric attempt", () => {
  assert.equal(connectionRetryToActivity({ sessionId: "s1" }), undefined);
  assert.equal(connectionRetryToActivity({ attempt: "4" }), undefined);
  assert.equal(connectionRetryToActivity(null), undefined);
  assert.equal(connectionRetryToActivity("retry"), undefined);
});

test("turnStatsToDimensions preserves main-chain stats for display only", () => {
  const dims = [
    {
      uid: "input_tokens",
      groupTitle: "Token Usage",
      label: "Input tokens",
      kind: { type: "cumulativeMetric", value: 195803 },
    },
  ];
  assert.equal(turnStatsToDimensions({ responseDimensions: dims })?.[0]?.kind?.value, 195803);
  assert.equal(turnStatsToDimensions("junk"), undefined);
});
