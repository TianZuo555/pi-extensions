import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { isSupportedVersion, pathCandidates } from "../src/binaries.ts";

test("binary version guards enforce features used by the runtime", () => {
  assert.equal(isSupportedVersion("rg", "ripgrep 11.0.2"), false);
  assert.equal(isSupportedVersion("rg", "ripgrep 12.0.0"), true);
  assert.equal(isSupportedVersion("rg", "ripgrep 15.1.0 (rev abc)"), true);
  assert.equal(isSupportedVersion("fd", "fdfind 8.6.0"), false);
  assert.equal(isSupportedVersion("fd", "fd 8.7.0"), true);
  assert.equal(isSupportedVersion("fd", "fd 10.3.0"), true);
  assert.equal(isSupportedVersion("fd", "unknown"), false);
});

test("fd resolution accepts Debian's fdfind alias", {
  skip: process.platform === "win32",
}, () => {
  const bin = mkdtempSync(path.join(tmpdir(), "pi-find-bin-"));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = bin;
    assert.deepEqual(pathCandidates("fd"), [path.join(bin, "fd"), path.join(bin, "fdfind")]);
  } finally {
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
  }
});
