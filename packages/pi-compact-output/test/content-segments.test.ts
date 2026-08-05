import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { parseAssistantContentSegments } from "../lib/content-segments.ts";

function segments(content: AssistantMessage["content"]) {
  return parseAssistantContentSegments(content);
}

test("parseAssistantContentSegments interleaves thinking and tools in order", () => {
  const parsed = segments([
    { type: "thinking", thinking: "plan" },
    { type: "toolCall", id: "t1", name: "read", arguments: {} },
    { type: "toolCall", id: "t2", name: "edit", arguments: {} },
    { type: "thinking", thinking: "revise" },
    { type: "toolCall", id: "t3", name: "bash", arguments: {} },
  ]);

  assert.deepEqual(parsed, [
    { kind: "thinking", segmentIndex: 0 },
    { kind: "tools", toolCallIds: ["t1", "t2"] },
    { kind: "thinking", segmentIndex: 1 },
    { kind: "tools", toolCallIds: ["t3"] },
  ]);
});

test("parseAssistantContentSegments merges consecutive thinking blocks", () => {
  const parsed = segments([
    { type: "thinking", thinking: "first pass" },
    { type: "thinking", thinking: "second pass" },
  ]);

  assert.deepEqual(parsed, [{ kind: "thinking", segmentIndex: 0 }]);
});

test("parseAssistantContentSegments ignores codex commentary text", () => {
  const parsed = segments([
    { type: "thinking", thinking: "plan" },
    {
      type: "text",
      text: "plan",
      textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }),
    },
    { type: "toolCall", id: "t1", name: "read", arguments: {} },
  ]);

  assert.deepEqual(parsed, [
    { kind: "thinking", segmentIndex: 0 },
    { kind: "tools", toolCallIds: ["t1"] },
  ]);
});
