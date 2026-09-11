import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * Entry-level: drive the real extension default export with a minimal pi
 * facade. With the bridge disabled and a pi-private skill loaded, the first
 * agy turn must surface exactly one ui.notify about unavailable skills —
 * never a prompt-side catalog.
 *
 * The home directory is isolated BEFORE importing index.ts: the model cache
 * path resolves under homedir() at module scope, and a fresh pre-seeded
 * cache keeps the startup refresh from running a background `agy models`
 * that could write outside the sandbox. Isolation must cover every env var
 * os.homedir() consults — HOME on POSIX, USERPROFILE (then HOMEDRIVE +
 * HOMEPATH) on Windows — or CI on windows-latest would silently redirect
 * nothing.
 */
test("bridge-disabled session warns once via ui.notify when pi-private skills exist", async () => {
  const realHome = homedir();
  const realCache = path.join(realHome, ".pi/antigravity/model-list.json");
  const realCacheBefore = await readFile(realCache, "utf-8").catch(() => undefined);

  const isoHome = await mkdtemp(path.join(tmpdir(), "agy-entry-home-"));
  const agentDir = path.join(isoHome, "pi-agent");
  await mkdir(path.join(isoHome, ".pi/antigravity"), { recursive: true });
  // A fresh live cache: modelCacheIsFresh() returns true, so the extension's
  // startup refresh is a no-op and no agy discovery ever spawns.
  const seededCache = JSON.stringify({
    fetchedAt: Date.now(),
    source: "live",
    models: [
      {
        id: "gemini-3.7-flash",
        name: "Gemini 3.7 Flash",
        supportedEfforts: ["high", "medium", "low"],
        defaultEffort: "high",
      },
    ],
  });
  const isoCache = path.join(isoHome, ".pi/antigravity/model-list.json");
  await writeFile(isoCache, seededCache);

  // Every variable os.homedir() may consult, on either platform.
  const homeVars = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;
  const prevHomeVars = new Map(homeVars.map((name) => [name, process.env[name]]));
  const prevBridge = process.env.PI_ANTIGRAVITY_PI_TOOL_BRIDGE;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevBinary = process.env.AGY_BINARY;

  const restoreEnv = () => {
    for (const [name, value] of prevHomeVars) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (prevBridge === undefined) delete process.env.PI_ANTIGRAVITY_PI_TOOL_BRIDGE;
    else process.env.PI_ANTIGRAVITY_PI_TOOL_BRIDGE = prevBridge;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevBinary === undefined) delete process.env.AGY_BINARY;
    else process.env.AGY_BINARY = prevBinary;
  };

  // Windows: HOMEDRIVE + HOMEPATH combine, so give them matching halves.
  process.env.HOME = isoHome;
  process.env.USERPROFILE = isoHome;
  process.env.HOMEDRIVE = "";
  process.env.HOMEPATH = isoHome;
  process.env.PI_ANTIGRAVITY_PI_TOOL_BRIDGE = "0";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Spawning must fail fast; the warning fires before any spawn anyway.
  process.env.AGY_BINARY = "/nonexistent/agy-under-test";
  // Fail loudly rather than silently leaking to the real profile.
  assert.equal(path.resolve(homedir()), path.resolve(isoHome));

  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let provider: { streamSimple: (...args: never[]) => AsyncIterable<unknown> } | undefined;
  const notifications: string[] = [];
  const pi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, fn);
    },
    registerCommand: () => {},
    registerEntryRenderer: () => {},
    registerProvider: (_name: string, p: unknown) => {
      provider = p as typeof provider;
    },
    registerTool: () => {},
    appendEntry: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
  };

  try {
    // The import must stay inside the env-isolated window: index.ts binds
    // homedir()-derived paths (model cache, bridge registry) at module scope.
    const { default: antigravityExtension } = await import("../index.ts");
    antigravityExtension(pi as never);
    assert.ok(provider, "the antigravity provider registered");

    const ui = {
      notify: (message: string) => notifications.push(message),
      setWidget: () => {},
    };
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      ui,
      // A non-antigravity model keeps session_start off the agy paths
      // (restore, bridge registration, model discovery).
      model: { provider: "pi", id: "fake-model" },
      sessionManager: { getBranch: () => [], getSessionId: () => "s1" },
    };
    await handlers.get("session_start")!({ reason: "new" }, ctx);

    const privateSkill = {
      name: "demo",
      description: "pi-private demo",
      filePath: path.join(agentDir, "skills/demo/SKILL.md"),
      baseDir: path.join(agentDir, "skills/demo"),
    };
    await handlers.get("before_agent_start")!(
      { systemPromptOptions: { skills: [privateSkill] } },
      ctx,
    );

    const model = {
      id: "gemini-3.7-flash",
      provider: "antigravity",
      api: "antigravity-stream-json",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const context = {
      systemPrompt: "",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    // Two turns: each evaluates getBootstrapSuffix; the warning dedupes.
    for (let i = 0; i < 2; i++) {
      for await (const _event of provider!.streamSimple(
        model as never,
        context as never,
        {} as never,
      )) {
        // Drain until the spawn failure ends the stream.
      }
    }

    const skillWarnings = notifications.filter((m) => /pi-private skills/.test(m));
    assert.equal(skillWarnings.length, 1, "warned exactly once across turns");
    assert.match(skillWarnings[0], /disabled/);

    // Nothing escaped the sandbox: the seeded cache is untouched (no
    // discovery overwrote it) and the real home cache never moved.
    assert.equal(await readFile(isoCache, "utf-8"), seededCache);
    const realCacheAfter = await readFile(realCache, "utf-8").catch(() => undefined);
    assert.equal(realCacheAfter, realCacheBefore);
  } finally {
    await Promise.resolve(handlers.get("session_shutdown")?.({}, {})).catch(() => {});
    restoreEnv();
    await rm(isoHome, { recursive: true, force: true });
  }
});
