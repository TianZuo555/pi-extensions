import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRexActivityReporter,
  formatRexActivityStatus,
  summarizeActivity,
} from "../lib/activity.ts";

test("formats a Rex working status with a base64 message", () => {
  assert.equal(
    formatRexActivityStatus("working", "fix the login redirect"),
    "\u001b]7501;state=working:app=pi:msg=Zml4IHRoZSBsb2dpbiByZWRpcmVjdA==\u001b\\",
  );
});

test("summarizes activity as one safe line", () => {
  assert.equal(summarizeActivity("  first line\nsecond\tline  "), "first line second line");
  assert.ok(Buffer.byteLength(summarizeActivity("界".repeat(200)), "utf8") <= 192);
});

test("reports each changed status once", () => {
  const reports: string[] = [];
  const reporter = createRexActivityReporter(
    (report) => reports.push(report),
    () => true,
  );

  reporter.working("task");
  reporter.working("task");
  reporter.done("task");
  reporter.idle();

  assert.deepEqual(reports, [
    formatRexActivityStatus("working", "task"),
    formatRexActivityStatus("done", "task"),
    formatRexActivityStatus("idle"),
  ]);
});

test("does not report when disabled", () => {
  const reports: string[] = [];
  const reporter = createRexActivityReporter(
    (report) => reports.push(report),
    () => false,
  );

  reporter.working("task");
  reporter.done("task");

  assert.deepEqual(reports, []);
});
