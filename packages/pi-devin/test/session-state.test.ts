import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  DEVIN_SESSION_STATE_ENTRY,
  parsePersistedDevinState,
  restorableDevinSession,
  type PersistedDevinSession,
} from "../lib/session-state.ts";

function customEntry(data: unknown): SessionEntry {
  return { type: "custom", customType: DEVIN_SESSION_STATE_ENTRY, data } as SessionEntry;
}

function messageEntry(): SessionEntry {
  return { type: "message", id: "m1" } as unknown as SessionEntry;
}

const STATE: PersistedDevinSession = {
  version: 1,
  kind: "session",
  sessionId: "pi-session-1",
  acpSessionId: "near-swan",
  cwd: "/tmp",
  modelId: "claude-opus-5",
  turns: 3,
  contextTokens: 12000,
};

test("restorableDevinSession returns the binding when branch ends cleanly", () => {
  const branch = [messageEntry(), customEntry(STATE)];
  assert.deepEqual(restorableDevinSession(branch, "pi-session-1", "/tmp"), STATE);
});

test("restorableDevinSession rejects stale bindings after context-changing entries", () => {
  const branch = [customEntry(STATE), messageEntry()];
  assert.equal(restorableDevinSession(branch, "pi-session-1", "/tmp"), undefined);
});

test("restorableDevinSession honors reset markers and foreign sessions", () => {
  const reset = { version: 1, kind: "reset", sessionId: "pi-session-1", cwd: "/tmp" };
  assert.equal(
    restorableDevinSession([customEntry(STATE), customEntry(reset)], "pi-session-1", "/tmp"),
    undefined,
  );
  assert.equal(restorableDevinSession([customEntry(STATE)], "other-pi-session", "/tmp"), undefined);
  assert.equal(restorableDevinSession([customEntry(STATE)], "pi-session-1", "/other"), undefined);
});

test("parsePersistedDevinState validates shape", () => {
  assert.equal(parsePersistedDevinState(STATE)?.kind, "session");
  assert.equal(parsePersistedDevinState({ ...STATE, turns: -1 }), undefined);
  assert.equal(parsePersistedDevinState({ ...STATE, acpSessionId: "" }), undefined);
  assert.equal(parsePersistedDevinState({ version: 2 }), undefined);
  assert.equal(parsePersistedDevinState("nope"), undefined);
});
