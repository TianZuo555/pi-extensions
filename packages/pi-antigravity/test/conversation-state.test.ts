import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  AGY_CONVERSATION_STATE_ENTRY,
  agyConversationDatabasePath,
  agyConversationExists,
  parsePersistedAgyState,
  restorableAgyConversation,
  type PersistedAgyConversation,
} from "../lib/conversation-state.ts";

const conversation: PersistedAgyConversation = {
  version: 1,
  kind: "conversation",
  sessionId: "pi-session-1",
  conversationId: "agy-conversation-1",
  cwd: "/repo",
  modelId: "gemini-3.7-flash",
  turns: 7,
  usage: { input_tokens: 10_000, output_tokens: 500, total_tokens: 10_500 },
  contextTokens: 42_000,
};

function entry(type: string, extra: Record<string, unknown> = {}, index = 1): SessionEntry {
  return {
    type,
    id: `entry-${index}`,
    parentId: index > 1 ? `entry-${index - 1}` : null,
    timestamp: new Date(index * 1_000).toISOString(),
    ...extra,
  } as SessionEntry;
}

function stateEntry(data: unknown, index = 1): SessionEntry {
  return entry("custom", { customType: AGY_CONVERSATION_STATE_ENTRY, data }, index);
}

test("persisted agy conversation restores only on its owning Pi session", () => {
  const branch = [stateEntry(conversation)];
  assert.deepEqual(restorableAgyConversation(branch, "pi-session-1", "/repo"), conversation);
  assert.equal(restorableAgyConversation(branch, "forked-session", "/repo"), undefined);
  assert.equal(restorableAgyConversation(branch, "pi-session-1", "/other"), undefined);
});

test("context-changing entries after the marker make a native resume stale", () => {
  const message = entry(
    "message",
    { message: { role: "user", content: [{ type: "text", text: "later" }], timestamp: 2_000 } },
    2,
  );
  assert.equal(
    restorableAgyConversation([stateEntry(conversation), message], "pi-session-1", "/repo"),
    undefined,
  );
});

test("UI-only entries after the marker do not prevent native resume", () => {
  const marker = entry(
    "custom",
    { customType: "pi-antigravity-compaction", data: { beforeTokens: 170_000 } },
    2,
  );
  assert.deepEqual(
    restorableAgyConversation([stateEntry(conversation), marker], "pi-session-1", "/repo"),
    conversation,
  );
});

test("newest reset marker prevents resurrecting an older conversation", () => {
  const reset = stateEntry(
    { version: 1, kind: "reset", sessionId: "pi-session-1", cwd: "/repo" },
    2,
  );
  assert.equal(
    restorableAgyConversation([stateEntry(conversation), reset], "pi-session-1", "/repo"),
    undefined,
  );
});

test("agyConversationExists checks the native conversation database", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pi-antigravity-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const database = agyConversationDatabasePath("conversation-1", home);
  await mkdir(join(home, ".gemini", "antigravity-cli", "conversations"), { recursive: true });
  assert.equal(await agyConversationExists("conversation-1", home), false);
  await writeFile(database, "sqlite");
  assert.equal(await agyConversationExists("conversation-1", home), true);
});

test("persisted state parser rejects malformed or negative accounting data", () => {
  assert.equal(parsePersistedAgyState({ ...conversation, turns: -1 }), undefined);
  assert.equal(
    parsePersistedAgyState({ ...conversation, usage: { input_tokens: Number.NaN } }),
    undefined,
  );
  assert.deepEqual(parsePersistedAgyState(conversation), conversation);
});
