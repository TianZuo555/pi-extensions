import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("lib/protocol.ts matches vscode/src/protocol.ts byte-for-byte", () => {
  const lib = readFileSync(join(root, "lib/protocol.ts"));
  const vscode = readFileSync(join(root, "vscode/src/protocol.ts"));
  assert.ok(
    lib.equals(vscode),
    "lib/protocol.ts and vscode/src/protocol.ts differ — re-copy with cp",
  );
});

test("lib/hunks.ts matches vscode/src/hunks.ts byte-for-byte", () => {
  const lib = readFileSync(join(root, "lib/hunks.ts"));
  const vscode = readFileSync(join(root, "vscode/src/hunks.ts"));
  assert.ok(lib.equals(vscode), "lib/hunks.ts and vscode/src/hunks.ts differ — re-copy with cp");
});
