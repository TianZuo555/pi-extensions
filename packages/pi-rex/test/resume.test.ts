import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { defaultResumeCommand, recordPath, recordText, registerResume } from "../lib/resume.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const BLOCK = "block:01a1-test";
const SHELL = process.env.SHELL;
const PS_MODULE_PATH = process.env.PSModulePath;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pi-rex-resume-"));
  process.env.REX_BLOCK = BLOCK;
  // Keep the hook install inside the temporary folder, and make the shell fish.
  process.env.XDG_CONFIG_HOME = dir;
  process.env.SHELL = "/opt/homebrew/bin/fish";
  // Windows sets PSModulePath, which would install the PowerShell profile
  // outside the temporary folder.
  delete process.env.PSModulePath;
});

afterEach(() => {
  delete process.env.REX_BLOCK;
  delete process.env.XDG_CONFIG_HOME;
  if (SHELL === undefined) delete process.env.SHELL;
  else process.env.SHELL = SHELL;
  if (PS_MODULE_PATH === undefined) delete process.env.PSModulePath;
  else process.env.PSModulePath = PS_MODULE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

function setup(
  options: { mode?: string; sessionFile?: string; cwd?: string; settings?: unknown } = {},
) {
  const handlers = new Map<string, Handler>();
  const notices: string[] = [];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getSettings: () => options.settings ?? {},
  };
  const sessionFile = options.sessionFile ?? path.join(dir, "session.jsonl");
  const ctx = {
    cwd: options.cwd ?? "/repo",
    mode: options.mode ?? "tui",
    sessionManager: { getSessionFile: () => sessionFile },
    ui: { notify: (message: string) => notices.push(message) },
  };
  registerResume(pi as never, dir);
  const fire = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  const record = recordPath(dir, BLOCK);
  if (!record) throw new Error("invalid test block ID");
  return { fire, notices, record, sessionFile };
}

test("names the record after the block ID without the prefix", () => {
  assert.equal(recordPath("/agent", "block:01a1"), path.join("/agent", "rex-resume", "01a1"));
  assert.equal(recordPath("/agent", "block:.."), undefined);
  assert.equal(recordPath("/agent", "../x"), undefined);
  assert.equal(recordPath("/agent", ""), undefined);
});

test("writes the directory and the resume command", async () => {
  const { fire, record, sessionFile } = setup();
  writeFileSync(sessionFile, "");
  await fire("session_start");
  assert.equal(readFileSync(record, "utf8"), recordText("/repo", sessionFile));
  assert.equal(recordText("/repo", "/s.jsonl"), "/repo\npi\n--session\n/s.jsonl\n");
});

test("recognizes Pi-Bolt launchers and compiled binaries", () => {
  assert.equal(defaultResumeCommand("/opt/homebrew/bin/pi-bolt"), "pi-bolt");
  assert.equal(defaultResumeCommand("C:\\Users\\me\\bin\\pi-bolt.exe"), "pi-bolt");
  assert.equal(defaultResumeCommand("/opt/pi-bolt/pi-bin"), "pi-bolt");
  assert.equal(defaultResumeCommand("/opt/pi-bolt-linux-x64/pi"), "pi-bolt");
  assert.equal(defaultResumeCommand("/opt/bin/node"), "pi");
  assert.equal(defaultResumeCommand("/opt/bin/pi"), "pi");
});

test("stores a custom launcher path as a single argument", async () => {
  const launcher = path.join(dir, "custom launcher");
  const { fire, record, sessionFile } = setup({ settings: { rex: { resumeCommand: launcher } } });
  writeFileSync(sessionFile, "");
  await fire("session_start");
  assert.deepEqual(readFileSync(record, "utf8").split("\n"), [
    "/repo",
    launcher,
    "--session",
    sessionFile,
    "",
  ]);
  await fire("session_shutdown", { reason: "quit" });
});

test("falls back to the default launcher for a multiline setting", async () => {
  const { fire, record, sessionFile } = setup({
    settings: { rex: { resumeCommand: "pi-bolt\n--extra" } },
  });
  writeFileSync(sessionFile, "");
  await fire("session_start");
  assert.equal(readFileSync(record, "utf8"), recordText("/repo", sessionFile));
  await fire("session_shutdown", { reason: "quit" });
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
  for (const reason of ["reload", "resume", "fork"]) {
    const { fire, record, sessionFile } = setup();
    writeFileSync(sessionFile, "");
    await fire("session_start");
    await fire("session_shutdown", { reason });
    assert.ok(existsSync(record), reason);
  }
});

test("removes the record on /new before the next session starts", async () => {
  const { fire, record, sessionFile } = setup();
  writeFileSync(sessionFile, "");
  await fire("session_start");
  await fire("session_shutdown", { reason: "new" });
  assert.ok(!existsSync(record));
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

test("removes the previous record when the new session has no file yet", async () => {
  const { fire, record, sessionFile } = setup();
  writeFileSync(sessionFile, "");
  await fire("session_start");
  await fire("session_shutdown", { reason: "new" });
  // `/new` starts a new extension runtime for a session with no file yet.
  const next = setup({ sessionFile: path.join(dir, "next.jsonl") });
  await next.fire("session_start");
  assert.ok(!existsSync(record));
});

test("writes no record for a line break in the directory", async () => {
  const { fire, record, sessionFile } = setup({ cwd: "/repo\nrm -rf /" });
  writeFileSync(sessionFile, "");
  await fire("session_start");
  assert.ok(!existsSync(record));
});

test("writes nothing outside the TUI or outside Rex", async () => {
  for (const mode of ["rpc", "json", "print"]) {
    const other = setup({ mode });
    writeFileSync(other.sessionFile, "");
    await other.fire("session_start");
    assert.ok(!existsSync(other.record), mode);
  }

  delete process.env.REX_BLOCK;
  const outside = setup();
  await outside.fire("session_start");
  assert.ok(!existsSync(outside.record));
});

const hookFile = () => path.join(dir, "fish", "conf.d", "rex-resume.fish");

test("installs the fish hook and reports it once", async () => {
  const { fire, notices } = setup();
  await fire("session_start");
  assert.match(readFileSync(hookFile(), "utf8"), /--on-event fish_prompt/);
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /installed the resume hook/);

  const second = setup();
  await second.fire("session_start");
  assert.ok(existsSync(hookFile()));
  assert.deepEqual(second.notices, []);
});

test("keeps a hook file the user wrote", async () => {
  mkdirSync(path.dirname(hookFile()), { recursive: true });
  writeFileSync(hookFile(), "# mine\n");
  const { fire, notices } = setup();
  await fire("session_start");
  assert.equal(readFileSync(hookFile(), "utf8"), "# mine\n");
  assert.deepEqual(notices, []);
});

test("installs no hook for a shell without one", async () => {
  // `sh` has no hook. A bash pane would get one in its startup file.
  process.env.SHELL = "/bin/sh";
  const { fire, notices } = setup();
  await fire("session_start");
  assert.ok(!existsSync(hookFile()));
  assert.deepEqual(notices, []);
});

test("removes the old record when resume is turned off", async () => {
  const on = setup();
  writeFileSync(on.sessionFile, "");
  await on.fire("session_start");
  assert.ok(existsSync(on.record));

  // A reload after `rex.resume: false` must not leave a record behind.
  const off = setup({ settings: { rex: { resume: false } } });
  await off.fire("session_start");
  assert.ok(!existsSync(on.record));
});

test("writes no record and no hook when resume is off", async () => {
  const { fire, record, sessionFile } = setup({ settings: { rex: { resume: false } } });
  writeFileSync(sessionFile, "");
  await fire("session_start");
  await fire("agent_end");
  assert.ok(!existsSync(record));
  assert.ok(!existsSync(hookFile()));
});
