import assert from "node:assert/strict";
import test from "node:test";
import { buildReplacementHistory } from "../src/checkpoint.ts";
import { isPermanentRouteFailure } from "../src/compact.ts";
import {
  prepareRemoteCompactionPayload,
  rewriteCheckpointMarker,
  rewriteCheckpointMarkerIfPresent,
} from "../src/protocol.ts";

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

test("optional turn rewrite leaves duplicate markers untouched without throwing", () => {
  const marker = "checkpoint-marker";
  const payload = {
    model: "test",
    input: [userItem(marker), userItem("middle"), userItem(marker)],
  };
  const before = structuredClone(payload);
  assert.equal(rewriteCheckpointMarkerIfPresent(payload, marker, [compactionItem]), undefined);
  assert.deepEqual(payload, before);
});

test("remote recompaction still rejects missing or duplicate checkpoint markers", () => {
  const marker = "checkpoint-marker";
  for (const input of [[], [userItem(marker), userItem(marker)]]) {
    const payload = { input };
    assert.throws(
      () => rewriteCheckpointMarker(payload, marker, [compactionItem]),
      /expected exactly one/,
    );
    assert.throws(
      () =>
        prepareRemoteCompactionPayload(payload, {
          marker,
          replacementHistory: [compactionItem],
        }),
      /expected exactly one/,
    );
  }
});

test("isPermanentRouteFailure recognizes HTTP context and invalid routes", () => {
  for (const message of [
    "HTTP 404: Not Found",
    "HTTP/1.1 405 Method Not Allowed",
    "HTTP status code 410: Gone",
    "status=501",
    "405 Method Not Allowed",
    "410 Gone",
    "501 Not Implemented",
    "Invalid URL",
    "TypeError: Invalid URL",
    "unknown endpoint",
    "Unsupported route",
    "endpoint is not found",
    "route does not exist",
  ])
    assert.equal(isPermanentRouteFailure(message), true, message);
});

test("isPermanentRouteFailure does not treat incidental numeric values as HTTP statuses", () => {
  for (const message of [
    "failed at byte offset 404",
    "request id 405 was interrupted",
    "retry after 410 seconds",
    "processed 501 items before disconnect",
    "model test-404 is overloaded",
    "HTTP 429: retry after 404 seconds",
    "HTTP status 408: request timed out",
  ])
    assert.equal(isPermanentRouteFailure(message), false, message);
});

test("isPermanentRouteFailure classifies endpoint-missing errors", () => {
  assert.equal(isPermanentRouteFailure("OpenAI API error (404): 404 page not found"), true);
  assert.equal(isPermanentRouteFailure("Unsupported service_tier: flex"), false);
  assert.equal(isPermanentRouteFailure("OpenAI API error (429): Too Many Requests"), false);
  assert.equal(isPermanentRouteFailure("OpenAI API error (408): Request Timeout"), false);
  assert.equal(isPermanentRouteFailure("OpenAI API error (401): Unauthorized"), false);
  assert.equal(isPermanentRouteFailure("fetch failed"), false);
  assert.equal(isPermanentRouteFailure("request timed out after 300000ms"), false);
});
