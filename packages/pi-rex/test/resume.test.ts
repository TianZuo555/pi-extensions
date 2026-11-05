import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { recordPath, recordText, registerResume } from "../lib/resume.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const BLOCK = "block:01a1-test";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pi-rex-resume-"));
  process.env.REX_BLOCK = BLOCK;
});

afterEach(() => {
  delete process.env.REX_BLOCK;
  rmSync(dir, { recursive: true, force: true });
});

function setup(options: { hasUI?: boolean; sessionFile?: string } = {}) {
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) };
  const sessionFile = options.sessionFile ?? path.join(dir, "session.jsonl");
  const ctx = {
    cwd: "/repo",
    hasUI: options.hasUI ?? true,
    sessionManager: { getSessionFile: () => sessionFile },
  };
  registerResume(pi as never, dir);
  const fire = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  const record = recordPath(dir, BLOCK);
  return { fire, record, sessionFile };
}

test("names the record after the block ID without the prefix", () => {
  assert.equal(recordPath("/agent", "block:01a1"), path.join("/agent", "rex-resume", "01a1"));
  assert.equal(recordPath("/agent", "../x"), path.join("/agent", "rex-resume", "x"));
});

test("writes the directory and the resume command", async () => {
  const { fire, record, sessionFile } = setup();
  writeFileSync(sessionFile, "");
  await fire("session_start");
  assert.equal(readFileSync(record, "utf8"), recordText("/repo", sessionFile));
  assert.equal(recordText("/repo", "/s.jsonl"), "/repo\npi\n--session\n/s.jsonl\n");
});

test("waits for the session file, then writes after the prompt", async () => {
  const { fire, record, sessionFile } = setup();
  await fire("session_start");
  assert.ok(!existsSync(record));
  writeFileSync(sessionFile, "");
  await fire("agent_end");
  assert.ok(existsSync(record));
});

test("removes the record when the user quits", async () => {
  const { fire, record, sessionFile } = setup();
  writeFileSync(sessionFile, "");
  await fire("session_start");
  await fire("session_shutdown", { reason: "quit" });
  assert.ok(!existsSync(record));
});

test("keeps the record for a reload or a session switch", async () => {
  for (const reason of ["reload", "new", "resume", "fork"]) {
    const { fire, record, sessionFile } = setup();
    writeFileSync(sessionFile, "");
    await fire("session_start");
    await fire("session_shutdown", { reason });
    assert.ok(existsSync(record), reason);
  }
});

test("keeps the record when a signal stops pi", async () => {
  for (const signal of ["SIGHUP", "SIGTERM"] as const) {
    const { fire, record, sessionFile } = setup();
    writeFileSync(sessionFile, "");
    const listeners = process.listenerCount(signal);
    await fire("session_start");
    // Pi's signal handler emits session_shutdown before later signal listeners run.
    const shutdown = fire("session_shutdown", { reason: "quit" });
    process.emit(signal);
    await shutdown;
    assert.ok(existsSync(record), signal);
    assert.equal(process.listenerCount(signal), listeners, signal);
  }
});

test("writes nothing without a UI or outside Rex", async () => {
  const noUi = setup({ hasUI: false });
  writeFileSync(noUi.sessionFile, "");
  await noUi.fire("session_start");
  assert.ok(!existsSync(noUi.record));

  delete process.env.REX_BLOCK;
  const outside = setup();
  await outside.fire("session_start");
  assert.ok(!existsSync(outside.record));
});
