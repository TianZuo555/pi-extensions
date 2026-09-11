import assert from "node:assert/strict";
import test from "node:test";
import { buildReplacementHistory } from "../src/checkpoint.ts";
import { isPermanentRouteFailure } from "../src/compact.ts";
import { rewriteCheckpointMarkerIfPresent } from "../src/protocol.ts";

const userItem = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const compactionItem = { type: "compaction", encrypted_content: "enc" };

test("buildReplacementHistory skips user items kept verbatim after the cut", () => {
  const input = [userItem("old secret ask"), userItem("recent question still in context")];
  const withDupes = buildReplacementHistory(input, compactionItem);
  assert.equal(withDupes.length, 3); // 2 retained + opaque item
  const deduped = buildReplacementHistory(input, compactionItem, {
    excludeTexts: new Set(["recent question still in context"]),
  });
  assert.equal(deduped.length, 2);
  assert.equal((deduped[0] as { content: { text: string }[] }).content[0].text, "old secret ask");
  assert.equal(deduped[1].type, "compaction");
});

test("rewriteCheckpointMarkerIfPresent returns undefined without the marker", () => {
  const marker = "[PI_CODEX_REMOTE_CHECKPOINT:abc] rest";
  const payload = { input: [userItem("hello")] };
  assert.equal(rewriteCheckpointMarkerIfPresent(payload, marker, []), undefined);
  const withMarker = {
    input: [
      userItem("before"),
      { type: "message", role: "user", content: [{ type: "input_text", text: marker }] },
      userItem("after"),
    ],
  };
  const rewritten = rewriteCheckpointMarkerIfPresent(withMarker, marker, [userItem("retained")]);
  const input = rewritten?.input as { content: { text: string }[] }[];
  assert.equal(input.length, 3);
  assert.equal(input[1].content[0].text, "retained");
});

test("isPermanentRouteFailure classifies endpoint-missing errors", () => {
  assert.equal(isPermanentRouteFailure("OpenAI API error (404): 404 page not found"), true);
  assert.equal(isPermanentRouteFailure("Unsupported service_tier: flex"), true);
  assert.equal(isPermanentRouteFailure("fetch failed"), false);
  assert.equal(isPermanentRouteFailure("request timed out after 300000ms"), false);
});
