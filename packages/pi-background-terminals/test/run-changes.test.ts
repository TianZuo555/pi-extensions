import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { OutputView, TerminalSnapshot } from "../src/domain.ts";
import {
  buildBashResult,
  buildTerminalResultMessage,
  changedFilesNote,
  MAX_CHANGED_PATHS,
} from "../src/prompt.ts";
import { createRunChangeTracker, resolveToolPath } from "../src/run-changes.ts";

function view(): OutputView {
  return { text: "", head: "", tail: "", totalBytes: 0, truncatedBytes: 0 };
}

function snap(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    id: "bt-1",
    command: "pnpm test",
    title: "test",
    cwd: "/repo/packages/x",
    pid: 123,
    status: "running",
    createdAt: 1_000,
    yielded: true,
    stdout: view(),
    stderr: view(),
    ...overrides,
  };
}

test("an edit inside a running command's directory is recorded for it", () => {
  const tracker = createRunChangeTracker();
  tracker.record("/repo/packages/x/src/lib.ts", [snap()]);
  assert.deepEqual(tracker.changedDuring("bt-1"), ["src/lib.ts"]);
});

test("edits outside the working directory, or while the command is not running, are ignored", () => {
  const tracker = createRunChangeTracker();
  const settled = snap({ status: "done", settledAt: 2_000, exitCode: 0 });
  tracker.record("/repo/packages/x/src/after.ts", [settled]);
  tracker.record("/repo/packages/y/src/other.ts", [snap()]);
  tracker.record("/elsewhere/README.md", [snap()]);
  assert.deepEqual(tracker.changedDuring("bt-1"), []);
});

test("a dot-prefixed name inside the directory is not mistaken for a parent path", () => {
  const tracker = createRunChangeTracker();
  tracker.record("/repo/packages/x/..env", [snap()]);
  tracker.record("/repo/packages/..x/lib.ts", [snap()]);
  assert.deepEqual(tracker.changedDuring("bt-1"), ["..env"]);
});

test("each change attaches to every command running at that moment", () => {
  // Calls from one assistant message run in parallel, so an edit can overlap
  // a command that never yielded as well as a background terminal.
  const tracker = createRunChangeTracker();
  const quick = snap({ id: "bt-2", yielded: false });
  tracker.record("/repo/packages/x/src/lib.ts", [snap(), quick]);
  assert.deepEqual(tracker.changedDuring("bt-1"), ["src/lib.ts"]);
  assert.deepEqual(tracker.changedDuring("bt-2"), ["src/lib.ts"]);
});

test("duplicate paths collapse and the list is sorted", () => {
  const tracker = createRunChangeTracker();
  tracker.record("/repo/packages/x/src/lib.ts", [snap()]);
  tracker.record("/repo/packages/x/src/lib.ts", [snap()]);
  tracker.record("/repo/packages/x/Cargo.toml", [snap()]);
  assert.deepEqual(tracker.changedDuring("bt-1"), ["Cargo.toml", "src/lib.ts"]);
});

test("changes of a terminal pruned from the manager are forgotten", () => {
  const tracker = createRunChangeTracker();
  tracker.record("/repo/packages/x/src/lib.ts", [snap()]);
  tracker.record("/repo/packages/x/src/next.ts", [snap({ id: "bt-2" })]);
  assert.deepEqual(tracker.changedDuring("bt-1"), []);
  assert.deepEqual(tracker.changedDuring("bt-2"), ["src/next.ts"]);
});

test("changed paths use forward slashes on every platform", () => {
  // The note is model-facing, so a Windows run must not report `src\lib.ts`.
  const tracker = createRunChangeTracker();
  tracker.record(path.join("/repo/packages/x", "src", "lib.ts"), [
    snap({ cwd: path.join("/repo/packages/x") }),
  ]);
  assert.deepEqual(tracker.changedDuring("bt-1"), ["src/lib.ts"]);
});

test("tool paths resolve like Pi's edit and write tools", () => {
  assert.equal(resolveToolPath("src/lib.ts", "/repo"), path.resolve("/repo/src/lib.ts"));
  assert.equal(resolveToolPath("@src/lib.ts", "/repo"), path.resolve("/repo/src/lib.ts"));
  assert.equal(resolveToolPath("/abs/lib.ts", "/repo"), path.resolve("/abs/lib.ts"));
  assert.equal(resolveToolPath("~", "/repo"), os.homedir());
  assert.equal(resolveToolPath("~/lib.ts", "/repo"), path.join(os.homedir(), "lib.ts"));
});

test("the note states the fact and names at most MAX_CHANGED_PATHS files", () => {
  const note = changedFilesNote(["src/lib.ts", "tests.rs"]);
  assert.match(note!, /^Changed while this command ran: src\/lib\.ts, tests\.rs\./);
  assert.match(note!, /may not reflect those changes/);
  assert.match(note!, /run the command again/);

  const many = Array.from({ length: MAX_CHANGED_PATHS + 2 }, (_, i) => `f${i}.ts`);
  assert.match(changedFilesNote(many)!, /\(\+2 more\)/);
  assert.equal(changedFilesNote([]), undefined);
});

test("a completion message carries the note before its output", () => {
  const text = buildTerminalResultMessage(
    snap({
      status: "done",
      settledAt: 2_000,
      exitCode: 0,
      stdout: { ...view(), text: "pass\n", head: "pass\n", totalBytes: 5 },
    }),
    Number.POSITIVE_INFINITY,
    ["tests.rs"],
  );
  const noteAt = text.indexOf("Changed while this command ran: tests.rs");
  assert.ok(noteAt >= 0, "note present");
  assert.ok(noteAt < text.indexOf("stdout:"), "note precedes the output it qualifies");
});

test("a completion message without changes stays unchanged", () => {
  const text = buildTerminalResultMessage(snap({ status: "done", settledAt: 2_000, exitCode: 0 }));
  assert.doesNotMatch(text, /Changed while this command/);
});

test("a bash result notes changes only once the command has settled", () => {
  const done = buildBashResult(snap({ status: "done", settledAt: 2_000, exitCode: 0 }), {
    changedFiles: ["src/lib.ts"],
  });
  assert.match(done, /Changed while this command ran: src\/lib\.ts/);
  // A yielded result has no outcome to qualify yet; its completion carries the note.
  const running = buildBashResult(snap(), { changedFiles: ["src/lib.ts"] });
  assert.doesNotMatch(running, /Changed while this command/);
});
