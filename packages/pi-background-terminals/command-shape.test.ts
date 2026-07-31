import assert from "node:assert/strict";
import test from "node:test";
import {
  duplicateCommandError,
  findDuplicateRunning,
  isStateOnlyCommand,
  stateOnlyCommandError,
} from "./src/command-shape.ts";
import type { OutputView, TerminalSnapshot } from "./src/domain.ts";

function view(): OutputView {
  return { text: "", head: "", tail: "", totalBytes: 0, truncatedBytes: 0 };
}

function snap(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    id: "bt-1",
    command: "npm test",
    title: "npm test",
    cwd: "/repo",
    pid: 321,
    status: "running",
    createdAt: Date.now() - 4_000,
    stdout: view(),
    stderr: view(),
    ...overrides,
  };
}

test("commands that only mutate the discarded shell are recognized", () => {
  for (const command of [
    "cd packages/x",
    "cd /tmp/some dir",
    "export FOO=1",
    "FOO=1",
    "cd a && cd b",
    "D=/repo; export PATH=/x:/y",
    "cd x\nexport FOO=1",
  ]) {
    assert.equal(isStateOnlyCommand(command), true, command);
  }
});

test("commands that do real work are never blocked", () => {
  for (const command of [
    "cd packages/x && npm test",
    "cd packages/x\nnpm test",
    "npm test",
    "echo hi",
    "cdk deploy",
    "cd x | tee log",
    // Ambiguous syntax fails open: substitution runs commands, redirects write
    // files, so neither is treated as a pure no-op.
    "FOO=$(npm publish)",
    "cd x > /dev/null",
    "export FOO=`id`",
  ]) {
    assert.equal(isStateOnlyCommand(command), false, command);
  }
});

test("the state-only error names the fix instead of only the rule", () => {
  const message = stateOnlyCommandError();
  assert.match(message, /was not executed/);
  assert.match(message, /working_dir/);
  assert.match(message, /cd packages\/x && npm test/);
});

test("duplicate detection matches only a running twin in the same directory", () => {
  const running = snap();
  const snapshots = [
    running,
    snap({ id: "bt-2", status: "done", settledAt: Date.now(), exitCode: 0 }),
    snap({ id: "bt-3", cwd: "/other-worktree" }),
    snap({ id: "bt-4", command: "npm run build" }),
  ];

  assert.equal(
    findDuplicateRunning(snapshots, "npm test", "/repo")?.id,
    running.id,
  );
  // A settled twin is a legitimate re-run.
  assert.equal(
    findDuplicateRunning([snapshots[1]], "npm test", "/repo"),
    undefined,
  );
  // Same command, different worktree.
  assert.equal(
    findDuplicateRunning(snapshots, "npm test", "/elsewhere"),
    undefined,
  );
  assert.equal(findDuplicateRunning([], "npm test", "/repo"), undefined);
});

test("the duplicate error corrects the hang assumption and offers an escape", () => {
  const message = duplicateCommandError(snap());
  assert.match(message, /already running as background terminal bt-1/);
  assert.match(message, /has not failed/);
  assert.match(message, /was not executed/);
  assert.match(message, /change the command text or use a different working_dir/);
});
