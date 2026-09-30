import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { piConfigDir } from "../lib/config.ts";
import { resetDevinBinaryCache } from "../lib/diagnostics.ts";
import { modelCacheTtlMs, parseDevinModels } from "../lib/models.ts";

const CACHE_DIR = piConfigDir("devin-acp");
const CACHE_FILE = `${CACHE_DIR}/models.json`;
const SETTINGS_FILE = `${CACHE_DIR}/settings.json`;
const OUTPUT = `New Family (new-family)
  new-family-low  New Family Low  [200K context, Free]
`;
const cachedCatalog = (source: "live" | "fallback", ageMs: number) => ({
  source,
  fetchedAt: Date.now() - ageMs,
  families: parseDevinModels(OUTPUT.replaceAll("new-family", "old-family")),
});

type Cache = ReturnType<typeof cachedCatalog>;
type Handler = (event: any, ctx: ExtensionContext) => unknown;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(t: TestContext, initial?: Cache) {
  let saved = initial;
  const originalExists = fs.existsSync;
  const originalRead = fs.readFileSync;
  const originalMkdir = fs.mkdirSync;
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, "existsSync", (file: fs.PathLike) => {
    if (String(file) === CACHE_FILE) return saved !== undefined;
    if (String(file) === SETTINGS_FILE) return false;
    return originalExists(file);
  });
  t.mock.method(fs, "readFileSync", (...[file, ...args]: Parameters<typeof fs.readFileSync>) => {
    if (String(file) === CACHE_FILE) return JSON.stringify(saved);
    if (path.basename(String(file)) === "credentials.toml") throw new Error("no test credentials");
    return originalRead(file, ...args);
  });
  t.mock.method(fs, "mkdirSync", (...[file, ...args]: Parameters<typeof fs.mkdirSync>) => {
    if (String(file) === CACHE_DIR) return undefined;
    return originalMkdir(file, ...args);
  });
  t.mock.method(
    fs,
    "writeFileSync",
    (...[file, data, ...args]: Parameters<typeof fs.writeFileSync>) => {
      if (String(file) === CACHE_FILE) {
        saved = JSON.parse(String(data)) as Cache;
        return;
      }
      return originalWrite(file, data, ...args);
    },
  );

  const previousBinary = process.env.DEVIN_BINARY;
  process.env.DEVIN_BINARY = "fake-devin";
  resetDevinBinaryCache();
  const requested = deferred();
  const registered = deferred();
  const calls: string[][] = [];
  let completeModels: (output?: string, code?: number) => void = () => {
    throw new Error("model discovery has not started");
  };
  t.mock.method(childProcess, "spawn", ((_binary: string, args: string[]) => {
    calls.push(args);
    const child = new ChildProcess();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdout = stdout;
    child.stderr = stderr;
    if (args[0] === "version") {
      queueMicrotask(() => {
        stdout.end("devin 3000.11.0 (test)");
        child.emit("close", 0);
      });
    } else {
      assert.deepEqual(args, ["models", "list"]);
      completeModels = (output = OUTPUT, code = 0) => {
        stdout.end(output);
        stderr.end(code === 0 ? "" : "discovery failed");
        child.emit("close", code);
      };
      requested.resolve();
    }
    return child;
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();

  const handlers = new Map<string, Handler>();
  const registrations: ProviderModelConfig[][] = [];
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    model: { provider: "other", id: "other-model" },
    sessionManager: { getSessionId: () => "test-session", getBranch: () => [] },
    ui: { setStatus() {} },
  } as unknown as ExtensionContext;
  extension({
    registerTool() {},
    registerCommand() {},
    registerProvider(name: string, config: { models: ProviderModelConfig[] }) {
      assert.equal(name, "devin");
      registrations.push(config.models);
      if (registrations.length > 1) registered.resolve();
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    getActiveTools: () => [],
    setActiveTools() {},
  } as unknown as ExtensionAPI);
  t.after(async () => {
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
    if (previousBinary === undefined) delete process.env.DEVIN_BINARY;
    else process.env.DEVIN_BINARY = previousBinary;
    resetDevinBinaryCache();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return {
    ctx,
    calls,
    registrations,
    requested: requested.promise,
    registered: registered.promise,
    complete: (output?: string, code?: number) => completeModels(output, code),
    saved: () => saved,
    start: async () => handlers.get("session_start")!({ reason: "new" }, ctx),
    selectDevin: async () => {
      ctx.model = { provider: "devin", id: "old-family" } as ExtensionContext["model"];
      await handlers.get("model_select")!({ model: ctx.model }, ctx);
    },
  };
}

const options = { timeout: 5_000 };

test(
  "loading the factory registers fallback models without launching CLI processes",
  options,
  async (t) => {
    const h = harness(t);
    await setImmediate();
    assert.equal(h.registrations.length, 1);
    assert.ok(h.registrations[0].some((model) => model.id === "adaptive"));
    assert.deepEqual(h.calls, []);
  },
);

for (const source of ["live", "fallback"] as const) {
  test(`session startup skips a fresh ${source} cache`, options, async (t) => {
    const h = harness(t, cachedCatalog(source, 60_000));
    await h.start();
    assert.deepEqual(h.calls, []);
    assert.equal(h.registrations.length, 1);
  });

  test(
    `session startup refreshes an expired ${source} cache with another provider selected`,
    options,
    async (t) => {
      const h = harness(t, cachedCatalog(source, modelCacheTtlMs(source) + 1_000));
      await h.start();
      await h.requested;
      // Session startup must finish without waiting for the CLI response.
      assert.deepEqual(
        h.registrations[0].map((model) => model.id),
        ["old-family"],
      );
      h.complete();
      await h.registered;
      assert.deepEqual(
        h.registrations.at(-1)!.map((model) => model.id),
        ["new-family"],
      );
      assert.equal(h.saved()?.source, "live");
      assert.ok(h.saved()!.fetchedAt > Date.now() - 5_000);
    },
  );
}

test("session startup discovers new families when no cache exists", options, async (t) => {
  const h = harness(t);
  await h.start();
  await h.requested;
  h.complete();
  await h.registered;
  assert.deepEqual(
    h.registrations.at(-1)!.map((model) => model.id),
    ["new-family"],
  );
});

test("model selection reuses the automatic refresh already in flight", options, async (t) => {
  const h = harness(t, cachedCatalog("live", modelCacheTtlMs("live") + 1_000));
  await h.start();
  await h.requested;
  const selection = h.selectDevin();
  await setImmediate();
  assert.equal(h.calls.filter((args) => args[0] === "models").length, 1);
  h.complete();
  await selection;
  assert.equal(h.registrations.length, 2);
  assert.equal(h.calls.filter((args) => args[0] === "models").length, 1);
});

for (const failure of ["empty output", "CLI error"] as const) {
  test(
    `discovery with ${failure} keeps the cached models and permits a retry`,
    options,
    async (t) => {
      const initial = cachedCatalog("live", modelCacheTtlMs("live") + 1_000);
      const h = harness(t, initial);
      h.ctx.model = { provider: "devin", id: "old-family" } as ExtensionContext["model"];
      const startup = h.start();
      await h.requested;
      h.complete("", failure === "CLI error" ? 1 : 0);
      await startup;
      assert.equal(h.registrations.at(-1)![0].id, "old-family");
      assert.deepEqual(h.saved(), initial);

      const selection = h.selectDevin();
      await setImmediate();
      assert.equal(h.calls.filter((args) => args[0] === "models").length, 2);
      h.complete();
      await selection;
      assert.equal(h.registrations.at(-1)![0].id, "new-family");
    },
  );
}
