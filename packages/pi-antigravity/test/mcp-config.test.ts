import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPrivateMcpConfig } from "../lib/mcp-config.ts";

// The actual private workspace format is consumed by both native and Pi agy agents.
test("private MCP configurations isolate credentials and clean up only their own directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agy-private-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = createPrivateMcpConfig(root);
  const b = createPrivateMcpConfig(root);
  assert.notEqual(a.directory, b.directory);
  assert.notEqual(a.serverName, b.serverName);
  assert.ok(a.serverName.length <= 16);
  assert.deepEqual(await readdir(root), [], "constructing an extension starts no resources");
  await writeFile(path.join(root, "foreign.json"), "keep");
  await a.write("http://127.0.0.1:1234/mcp", "token-a");
  await b.write("http://127.0.0.1:5678/mcp", "token-b");
  const configFile = (directory: string) => path.join(directory, ".agents", "mcp_config.json");
  assert.deepEqual(JSON.parse(await readFile(configFile(a.directory), "utf8")), {
    mcpServers: {
      [a.serverName]: {
        serverUrl: "http://127.0.0.1:1234/mcp",
        headers: { "x-pi-bridge-token": "token-a" },
      },
    },
  });
  assert.equal((await readFile(configFile(b.directory), "utf8")).includes("token-a"), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(a.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.dirname(configFile(a.directory)))).mode & 0o777, 0o700);
    assert.equal((await stat(configFile(a.directory))).mode & 0o777, 0o600);
  }
  await a.remove();
  await a.remove();
  assert.equal(await readFile(path.join(root, "foreign.json"), "utf8"), "keep");
  assert.equal((await readFile(configFile(b.directory), "utf8")).includes("token-b"), true);
  await a.write("http://127.0.0.1:9012/mcp", "new-token");
  assert.equal((await readFile(configFile(a.directory), "utf8")).includes("new-token"), true);
  await a.remove();
  await b.remove();
  assert.deepEqual(await readdir(root), ["foreign.json"]);
});

test("failed private configuration writes can remove a partially created directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agy-private-mcp-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = createPrivateMcpConfig(root);
  await mkdir(config.directory, { recursive: true });
  await writeFile(path.join(config.directory, ".agents"), "not a directory");
  await assert.rejects(config.write("http://127.0.0.1:1234/mcp", "token"));
  await config.remove();
  assert.deepEqual(await readdir(root), []);
});
