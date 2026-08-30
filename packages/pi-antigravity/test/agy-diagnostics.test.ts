import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  checkAgyBinary,
  extractAgyVersion,
  resetAgyBinaryCache,
  resolveAgyBinary,
  runAgyCommand,
} from "../lib/agy-diagnostics.ts";

interface FakeProcessOptions {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: NodeJS.ErrnoException;
  hang?: boolean;
}

function fakeSpawn(options: FakeProcessOptions) {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      pid?: number;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      if (options.error) {
        child.emit("error", options.error);
        return;
      }
      if (options.hang) return;
      if (options.stdout) child.stdout.write(options.stdout);
      if (options.stderr) child.stderr.write(options.stderr);
      child.emit("close", options.code ?? 0);
    });
    return child;
  }) as never;
}

const found = async (command: string) => `/resolved/${command.replaceAll("/", "_")}`;

test("extractAgyVersion recognizes stdout, stderr, dev, and HEAD", () => {
  assert.deepEqual(extractAgyVersion("1.1.22\n"), { version: "1.1.22", development: false });
  assert.deepEqual(extractAgyVersion("", "agy v1.4.0\n"), {
    version: "1.4.0",
    development: false,
  });
  assert.deepEqual(extractAgyVersion("agy dev build"), { version: "dev", development: true });
  assert.deepEqual(extractAgyVersion("agy HEAD"), { version: "HEAD", development: true });
  assert.equal(extractAgyVersion("version unknown"), undefined);
});

test("explicit AGY_BINARY is strict and PATH then managed fallback are ordered", async () => {
  const explicitCalls: string[] = [];
  const explicit = await resolveAgyBinary({
    env: { AGY_BINARY: "/custom/agy", PATH: "/bin" },
    whichOverride: async (command) => {
      explicitCalls.push(command);
      throw new Error("missing");
    },
  });
  assert.equal(explicit.strict, true);
  assert.deepEqual(explicit.candidates, []);
  assert.deepEqual(explicitCalls, ["/custom/agy"]);

  const calls: string[] = [];
  const fallback = await resolveAgyBinary({
    env: { PATH: "/bin" },
    homeDir: "/home/test",
    whichOverride: async (command) => {
      calls.push(command);
      if (command === "agy") throw new Error("missing");
      return command;
    },
  });
  assert.deepEqual(calls, ["agy", "/home/test/.gemini/bin/agy"]);
  assert.equal(fallback.candidates[0]?.source, "managed");

  const windows = await resolveAgyBinary({
    env: { PATH: "C:\\bin" },
    homeDir: "C:\\Users\\test",
    platform: "win32",
    whichOverride: async (command) => command,
  });
  assert.ok(windows.candidates.some((candidate) => candidate.configured.endsWith("agy.exe")));
});

test("checkAgyBinary accepts the minimum, newer, and development builds", async () => {
  for (const output of ["1.1.22", "1.9.0", "agy dev", "agy HEAD"]) {
    resetAgyBinaryCache();
    const checked = await checkAgyBinary({
      env: { AGY_BINARY: "/fake/agy" },
      whichOverride: found,
      spawnOverride: fakeSpawn({ stdout: output }),
    });
    assert.equal(checked.ok, true, output);
  }
});

test("checkAgyBinary categorizes unsupported, malformed, spawn, permission, and timeout failures", async () => {
  const cases: Array<{
    expected: string;
    spawn: ReturnType<typeof fakeSpawn>;
    timeoutMs?: number;
  }> = [
    { expected: "unsupported-version", spawn: fakeSpawn({ stdout: "1.1.21" }) },
    { expected: "invalid-version", spawn: fakeSpawn({ stdout: "banana" }) },
    { expected: "spawn-failed", spawn: fakeSpawn({ code: 2, stderr: "bad" }) },
    {
      expected: "permission-denied",
      spawn: fakeSpawn({ error: Object.assign(new Error("denied"), { code: "EACCES" }) }),
    },
    {
      expected: "not-found",
      spawn: fakeSpawn({ error: Object.assign(new Error("gone"), { code: "ENOENT" }) }),
    },
    { expected: "timeout", spawn: fakeSpawn({ hang: true }), timeoutMs: 5 },
  ];
  for (const entry of cases) {
    resetAgyBinaryCache();
    const checked = await checkAgyBinary({
      env: { AGY_BINARY: "/fake/agy" },
      whichOverride: found,
      spawnOverride: entry.spawn,
      timeoutMs: entry.timeoutMs,
    });
    assert.equal(checked.ok, false);
    if (!checked.ok) assert.equal(checked.category, entry.expected);
  }
});

test("automatic selection chooses the newest compatible stable candidate", async () => {
  resetAgyBinaryCache();
  const checked = await checkAgyBinary({
    env: { PATH: "/bin" },
    homeDir: "/home/test",
    whichOverride: async (command) =>
      command === "agy" ? "/path/agy" : "/home/test/.gemini/bin/agy",
    spawnOverride: ((file: string) =>
      (
        fakeSpawn({ stdout: file === "/path/agy" ? "1.1.22" : "1.4.0" }) as () => unknown
      )()) as never,
  });
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  assert.equal(checked.binary, "/home/test/.gemini/bin/agy");
  assert.equal(checked.version, "1.4.0");
  assert.match(checked.selectionReason ?? "", /highest compatible stable/);
  assert.deepEqual(
    checked.candidates?.map(({ source, version, ok }) => ({ source, version, ok })),
    [
      { source: "path", version: "1.1.22", ok: true },
      { source: "managed", version: "1.4.0", ok: true },
    ],
  );
});

test("automatic selection prefers stable over a newer prerelease", async () => {
  resetAgyBinaryCache();
  const checked = await checkAgyBinary({
    env: { PATH: "/bin" },
    homeDir: "/home/test",
    whichOverride: async (command) =>
      command === "agy" ? "/path/agy" : "/home/test/.gemini/bin/agy",
    spawnOverride: ((file: string) =>
      (
        fakeSpawn({ stdout: file === "/path/agy" ? "1.4.0" : "2.0.0-beta.1" }) as () => unknown
      )()) as never,
  });
  assert.equal(checked.ok && checked.binary, "/path/agy");
  assert.match((checked.ok && checked.selectionReason) || "", /stable/);
});

test("automatic selection bypasses an incompatible PATH binary", async () => {
  resetAgyBinaryCache();
  const checked = await checkAgyBinary({
    env: { PATH: "/bin" },
    homeDir: "/home/test",
    whichOverride: async (command) =>
      command === "agy" ? "/path/agy" : "/home/test/.gemini/bin/agy",
    spawnOverride: ((file: string) =>
      (
        fakeSpawn({ stdout: file === "/path/agy" ? "1.1.21" : "1.2.0" }) as () => unknown
      )()) as never,
  });
  assert.equal(checked.ok && checked.binary, "/home/test/.gemini/bin/agy");
  assert.equal(checked.candidates?.[0]?.category, "unsupported-version");
});

test("automatic selection prefers a compatible stable build over development", async () => {
  resetAgyBinaryCache();
  const checked = await checkAgyBinary({
    env: { PATH: "/bin" },
    homeDir: "/home/test",
    whichOverride: async (command) =>
      command === "agy" ? "/path/agy" : "/home/test/.gemini/bin/agy",
    spawnOverride: ((file: string) =>
      (
        fakeSpawn({ stdout: file === "/path/agy" ? "agy HEAD" : "1.2.0" }) as () => unknown
      )()) as never,
  });
  assert.equal(checked.ok && checked.binary, "/home/test/.gemini/bin/agy");
});

test("auxiliary commands use the exact preflight-selected binary", async () => {
  resetAgyBinaryCache();
  const checked = await checkAgyBinary({
    env: { AGY_BINARY: "/configured/agy" },
    whichOverride: async () => "/selected/agy",
    spawnOverride: fakeSpawn({ stdout: "1.1.22" }),
  });
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  let invoked = "";
  await runAgyCommand(["models"], {
    binary: checked.binary,
    spawnOverride: ((file: string) => {
      invoked = file;
      const commandSpawn = fakeSpawn({ stdout: "model\tModel\n" }) as unknown as () => unknown;
      return commandSpawn();
    }) as never,
  });
  assert.equal(invoked, "/selected/agy");
});

test("candidate file changes invalidate a cached compatibility result", async () => {
  resetAgyBinaryCache();
  let signature = 1;
  let version = "1.1.22";
  let spawns = 0;
  const options = {
    env: { AGY_BINARY: "/fake/agy" },
    whichOverride: found,
    statOverride: async () => ({ mtimeMs: signature, ctimeMs: signature, size: signature }),
    spawnOverride: (() => {
      spawns += 1;
      return (fakeSpawn({ stdout: version }) as unknown as () => unknown)();
    }) as never,
  };
  const first = await checkAgyBinary(options);
  version = "1.2.0";
  const cached = await checkAgyBinary(options);
  signature += 1;
  const refreshed = await checkAgyBinary(options);
  assert.equal(first.ok && first.version, "1.1.22");
  assert.equal(cached.ok && cached.version, "1.1.22");
  assert.equal(refreshed.ok && refreshed.version, "1.2.0");
  assert.equal(first.ok && cached.ok && first.revision, cached.ok && cached.revision);
  assert.notEqual(first.ok && first.revision, refreshed.ok && refreshed.revision);
  assert.equal(spawns, 2);
});

test("forced refresh drops a stale success and cache keys follow binary configuration", async () => {
  resetAgyBinaryCache();
  const env = { AGY_BINARY: "/fake/agy" };
  const first = await checkAgyBinary({
    env,
    whichOverride: found,
    spawnOverride: fakeSpawn({ stdout: "1.1.22" }),
  });
  assert.equal(first.ok && first.version, "1.1.22");

  const failed = await checkAgyBinary({
    env,
    refresh: true,
    whichOverride: found,
    spawnOverride: fakeSpawn({ code: 2 }),
  });
  assert.equal(failed.ok, false);
  const retried = await checkAgyBinary({
    env,
    whichOverride: found,
    spawnOverride: fakeSpawn({ stdout: "1.2.0" }),
  });
  assert.equal(retried.ok && retried.version, "1.2.0");
});

test("checkAgyBinary bounds diagnostics and never invokes an installer", async () => {
  resetAgyBinaryCache();
  const checked = await checkAgyBinary({
    env: { AGY_BINARY: "/fake/agy" },
    whichOverride: found,
    spawnOverride: fakeSpawn({ stderr: `1.1.22\n${"x".repeat(20_000)}` }),
  });
  assert.equal(checked.ok, true);
  assert.ok(checked.stderr.length <= 8_192);
});
