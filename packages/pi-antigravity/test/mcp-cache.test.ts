import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agyMcpCacheDir, removeMcpCacheEntry } from "../lib/mcp-cache.ts";

test("cache cleanup removes only the acquired server key and tolerates repeated cleanup", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "agy-mcp-cache-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cache = agyMcpCacheDir(home);
  for (const name of ["pi-session-a", "pi-session-b", "pi-bridge-111", "foreign-server"]) {
    await mkdir(path.join(cache, name), { recursive: true });
    await writeFile(path.join(cache, name, "tool.json"), "{}");
  }
  await removeMcpCacheEntry("pi-session-a", home);
  await removeMcpCacheEntry("pi-session-a", home);
  assert.equal(existsSync(path.join(cache, "pi-session-a")), false);
  for (const name of ["pi-session-b", "pi-bridge-111", "foreign-server"]) {
    assert.equal(existsSync(path.join(cache, name, "tool.json")), true);
  }
});
