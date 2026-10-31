import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createLogRetention } from "../src/log-retention.ts";

function logFile(t: test.TestContext, bytes: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-retention-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "stdout.log");
  fs.writeFileSync(file, "x".repeat(bytes));
  return file;
}

test("log retention keeps files under the limit", (t) => {
  const retention = createLogRetention(100);
  assert.deepEqual(retention.add([logFile(t, 40)]), []);
  assert.deepEqual(retention.add([logFile(t, 60)]), []);
});

test("log retention returns the oldest files past the limit", (t) => {
  const retention = createLogRetention(100);
  const oldest = [logFile(t, 40), logFile(t, 10)];
  const middle = logFile(t, 40);
  retention.add(oldest);
  retention.add([middle]);
  assert.deepEqual(retention.add([logFile(t, 30)]), oldest);
  assert.deepEqual(retention.add([logFile(t, 50)]), [middle]);
});

test("log retention keeps the newest files when they alone pass the limit", (t) => {
  const retention = createLogRetention(100);
  const older = logFile(t, 10);
  retention.add([older]);
  const huge = logFile(t, 500);
  assert.deepEqual(retention.add([huge]), [older]);
  // A later terminal makes the large log the oldest one.
  assert.deepEqual(retention.add([logFile(t, 10)]), [huge]);
});

test("log retention counts a missing file as empty", () => {
  const retention = createLogRetention(100);
  assert.deepEqual(retention.add(["/nonexistent/bt-retention.log"]), []);
});
