import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  parseAgyConversationMetadata,
  readAgyConversationMetadata,
} from "../lib/conversation-metadata.ts";

const ID = "conversation-123";
const SHAPE = {
  conversations: {
    [ID]: {
      summary: {
        ID,
        Title: "Implement persistent agy driver",
        Preview: "Reuse one process",
        NumSteps: 17,
        UpdatedAt: "2026-09-01T10:11:12.000Z",
        WorkspaceURIs: ["file:///repo"],
        AgentName: "default",
      },
    },
  },
};

test("parseAgyConversationMetadata accepts the real capitalized shape", () => {
  assert.deepEqual(parseAgyConversationMetadata(SHAPE, ID), {
    id: ID,
    title: "Implement persistent agy driver",
    preview: "Reuse one process",
    numSteps: 17,
    updatedAt: "2026-09-01T10:11:12.000Z",
    workspaceUris: ["file:///repo"],
    agentName: "default",
  });
});

test("parseAgyConversationMetadata bounds and rejects malformed identity", () => {
  const malformed = structuredClone(SHAPE);
  malformed.conversations[ID].summary.ID = "other";
  assert.equal(parseAgyConversationMetadata(malformed, ID), undefined);

  const partial = structuredClone(SHAPE);
  partial.conversations[ID].summary.Title = "x".repeat(600);
  partial.conversations[ID].summary.NumSteps = -1;
  partial.conversations[ID].summary.UpdatedAt = "not-a-date";
  const parsed = parseAgyConversationMetadata(partial, ID);
  assert.equal(parsed?.title, undefined);
  assert.equal(parsed?.numSteps, undefined);
  assert.equal(parsed?.updatedAt, undefined);
});

test("readAgyConversationMetadata tolerates missing, malformed, and oversized files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-metadata-"));
  const file = path.join(dir, "conversation_metadata.json");
  try {
    assert.equal((await readAgyConversationMetadata(ID, { file })).status, "missing");
    await writeFile(file, "not json");
    assert.equal((await readAgyConversationMetadata(ID, { file })).status, "invalid");
    await writeFile(file, Buffer.from([0xff, 0xfe]));
    assert.equal((await readAgyConversationMetadata(ID, { file })).status, "invalid");
    await writeFile(file, JSON.stringify(SHAPE));
    const ok = await readAgyConversationMetadata(ID, { file });
    assert.equal(ok.status, "ok");
    assert.equal(ok.metadata?.title, "Implement persistent agy driver");
    assert.equal(
      (await readAgyConversationMetadata(ID, { file, maxBytes: 4 })).status,
      "oversized",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
