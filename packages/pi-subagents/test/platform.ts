import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * Shared platform guards for the test suite.
 *
 * Windows differs from POSIX in two ways this suite depends on:
 *
 *  1. There are no POSIX permission bits. `stat().mode` reports 0o666/0o444 no
 *     matter how a file was created, so the 0o700/0o600 privacy checks cannot
 *     hold there — artifact privacy on Windows rests on the ACLs of the user
 *     profile directory instead.
 *  2. Git behaviour that the tests drive through internal state (corrupting
 *     `.git/worktrees/<id>/index` to force a status failure) is not reproducible.
 */
export const posixOnly = process.platform === "win32" ? { skip: "POSIX-only semantics" } : {};

/** Assert a private permission mask, skipped on Windows where it cannot hold. */
export function assertPrivateMode(target: string, expected: number): void {
  if (process.platform === "win32") return;
  assert.equal(fs.statSync(target).mode & 0o777, expected);
}
