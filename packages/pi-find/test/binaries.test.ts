import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathCandidates } from "../src/binaries.ts";

test("fd resolution accepts Debian's fdfind alias", {
  skip: process.platform === "win32",
}, () => {
  const bin = mkdtempSync(path.join(tmpdir(), "pi-find-bin-"));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = bin;
    assert.deepEqual(pathCandidates("fd"), [
      path.join(bin, "fd"),
      path.join(bin, "fdfind"),
    ]);
  } finally {
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
  }
});
