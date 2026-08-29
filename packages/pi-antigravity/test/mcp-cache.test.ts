import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { agyMcpCacheDir, pruneBridgeMcpCache, removeMcpCacheEntry } from "../lib/mcp-cache.ts";

async function makeCacheHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "agy-mcp-cache-"));
  const cache = agyMcpCacheDir(home);
  for (const name of ["pi-bridge", "pi-bridge-111", "pi-bridge-222", "someone-elses"]) {
    await mkdir(path.join(cache, name), { recursive: true });
    await writeFile(path.join(cache, name, "tool.json"), "{}");
  }
  return home;
}

test("pruneBridgeMcpCache removes dead bridge entries, keeps live and foreign ones", async () => {
  const home = await makeCacheHome();
  try {
    const removed = await pruneBridgeMcpCache({
      liveServers: ["pi-bridge-222"],
      home,
    });
    assert.deepEqual(removed.sort(), ["pi-bridge", "pi-bridge-111"]);
    const cache = agyMcpCacheDir(home);
    assert.equal(existsSync(path.join(cache, "pi-bridge-222")), true);
    assert.equal(existsSync(path.join(cache, "someone-elses")), true);
    assert.equal(existsSync(path.join(cache, "pi-bridge-111")), false);
    assert.equal(existsSync(path.join(cache, "pi-bridge")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("pruneBridgeMcpCache ignores non-pid bridge-like names", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agy-mcp-cache-"));
  try {
    const cache = agyMcpCacheDir(home);
    await mkdir(path.join(cache, "pi-bridge-not-ours"), { recursive: true });
    const removed = await pruneBridgeMcpCache({ liveServers: [], home });
    assert.deepEqual(removed, []);
    assert.equal(existsSync(path.join(cache, "pi-bridge-not-ours")), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("pruneBridgeMcpCache is a no-op when the cache directory is absent", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agy-mcp-cache-"));
  try {
    const removed = await pruneBridgeMcpCache({ liveServers: [], home });
    assert.deepEqual(removed, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("removeMcpCacheEntry removes one entry and tolerates missing ones", async () => {
  const home = await makeCacheHome();
  try {
    await removeMcpCacheEntry("pi-bridge-111", home);
    await removeMcpCacheEntry("never-existed", home); // must not throw
    const cache = agyMcpCacheDir(home);
    assert.equal(existsSync(path.join(cache, "pi-bridge-111")), false);
    assert.equal(existsSync(path.join(cache, "pi-bridge-222")), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
