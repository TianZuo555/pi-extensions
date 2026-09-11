/**
 * Integration test against a real `devin acp` process. Skipped when the
 * devin binary is unavailable or unauthenticated (CI machines). Runs a full
 * initialize → session/new → prompt round-trip plus a custom-notification
 * check, bounded by hard timeouts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DevinAcpClient } from "../lib/acp-client.ts";
import { checkDevinBinary } from "../lib/diagnostics.ts";

const binary = await checkDevinBinary();
const skipReason = binary.ok ? undefined : `devin binary unavailable: ${binary.message}`;

test("DevinAcpClient performs a real ACP prompt round-trip", {
  skip: skipReason,
  timeout: 120_000,
}, async () => {
  const custom: string[] = [];
  const updates: string[] = [];
  const client = new DevinAcpClient({
    binary: binary.ok ? binary.binary : "devin",
  });
  client.setCustomNotificationHandler((method) => custom.push(method));
  try {
    await client.ensureStarted();
    const created = await client.newSession(process.cwd());
    assert.ok(created.sessionId, "session/new must return a sessionId");

    client.setSessionListener(created.sessionId, (update) => {
      updates.push(update.sessionUpdate);
    });

    const result = await client.prompt(created.sessionId, [
      { type: "text", text: "Reply with the single word: pong" },
    ]);
    assert.ok(result.stopReason, "prompt must resolve with a stopReason");
    assert.ok(updates.includes("agent_message_chunk"), "expected streamed agent message chunks");
    assert.ok(updates.includes("usage_update"), "expected a usage_update during the turn");
    assert.ok(
      custom.includes("_cognition.ai/agent_stopped"),
      "expected the Cognition agent_stopped notification",
    );
  } finally {
    await client.close();
  }
});
