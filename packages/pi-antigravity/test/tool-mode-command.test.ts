import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadSavedAgyToolMode } from "../lib/tool-mode-settings.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

test("agy-tools command toggles safely, waits for idle, and restores the old mode on failure", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "agy-tools-command-"));
  const agentDir = path.join(home, "pi-agent");
  const env: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: "",
    HOMEPATH: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_ANTIGRAVITY_PI_TOOL_BRIDGE: "1",
    PI_ANTIGRAVITY_TOOLS: undefined,
    PI_ANTIGRAVITY_AGENT: undefined,
    AGY_BINARY: path.join(home, "missing-agy"),
  };
  const previous = new Map(Object.keys(env).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  assert.equal(path.resolve(homedir()), path.resolve(home));
  const cache = path.join(agentDir, "antigravity");
  await mkdir(cache, { recursive: true });
  await writeFile(
    path.join(cache, "model-list.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      source: "live",
      models: [{ id: "test-model", name: "Test", supportedEfforts: [] }],
    }),
  );

  type Command = {
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    getArgumentCompletions?: (prefix: string) => Array<{ value: string }>;
  };
  const commands = new Map<string, Command>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const notices: Array<{ message: string; type: string }> = [];
  const footer = new Map<string, string | undefined>();
  const history = { type: "message", message: { role: "user", content: "Keep my history" } };
  const branch: unknown[] = [history];
  let waitForIdle = async () => {};
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      handlers.set(name, handler),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerFlag: () => {},
    getFlag: () => undefined,
    registerEntryRenderer: () => {},
    registerProvider: () => {},
    registerTool: () => {},
    getActiveTools: () => ["read"],
    getAllTools: () => [{ name: "read", sourceInfo: { path: "builtin:read" } }],
    getCommands: () => [],
    setActiveTools: () => {},
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
  };
  const ctx = {
    cwd: home,
    model: { provider: "other", id: "test-model" },
    hasUI: true,
    ui: {
      notify: (message: string, type: string) => notices.push({ message, type }),
      setWidget: () => {},
      setStatus: (key: string, value: string | undefined) => footer.set(key, value),
    },
    sessionManager: { getBranch: () => branch, getSessionId: () => "test-session" },
    waitForIdle: () => waitForIdle(),
  };
  t.after(async () => {
    try {
      await handlers.get("session_shutdown")?.({}, {});
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(home, { recursive: true, force: true });
    }
  });
  const { default: extension } = await import("../index.ts");
  extension(pi as never);
  await handlers.get("session_start")!({ reason: "new" }, ctx);
  const command = commands.get("agy-tools")!;
  assert.ok(command);
  const run = (args: string) => commands.get("agy-tools")!.handler(args, ctx as never);
  const settingsFile = path.join(agentDir, "settings.json");
  const savedMode = () => loadSavedAgyToolMode(settingsFile);
  const status = async () => {
    await run("status");
    return notices.at(-1)!.message;
  };

  assert.match(await status(), /OFF \(native\)/);
  assert.deepEqual(
    command.getArgumentCompletions!("o").map((item) => item.value),
    ["on", "off"],
  );
  await run("on off");
  assert.match(notices.at(-1)!.message, /usage/);
  assert.equal(branch.length, 1);

  await t.test("an active run finishes before switching and Pi history remains", async () => {
    let release!: () => void;
    const idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    waitForIdle = () => idle;
    const pending = run("on");
    assert.match(await status(), /OFF \(native\)/);
    assert.equal(branch.length, 1);
    release();
    await pending;
    waitForIdle = async () => {};
    assert.match(await status(), /ON \(pi\)/);
    assert.equal(savedMode(), "pi");
    assert.equal(branch.length, 2);
    assert.equal(branch[0], history);
  });

  await t.test("on/off are idempotent and no argument toggles both ways", async () => {
    const before = branch.length;
    await rm(settingsFile);
    await run("on");
    assert.equal(savedMode(), "pi");
    assert.equal(branch.length, before);
    await run("off");
    assert.match(await status(), /OFF \(native\)/);
    await run("");
    assert.match(await status(), /ON \(pi\)/);
    await run("");
    assert.match(await status(), /OFF \(native\)/);
    assert.equal(branch[0], history);
  });

  await t.test("invalid Pi-mode settings leave the old mode untouched", async () => {
    const before = branch.length;
    process.env.PI_ANTIGRAVITY_AGENT = "custom-agent";
    try {
      await run("on");
      assert.match(notices.at(-1)!.message, /unset PI_ANTIGRAVITY_AGENT/);
      assert.match(await status(), /OFF \(native\)/);
      assert.equal(branch.length, before);
    } finally {
      delete process.env.PI_ANTIGRAVITY_AGENT;
    }
  });

  await t.test(
    "bridge preparation failure rolls back without selecting a default Pi agent",
    async () => {
      const blocker = path.join(cache, "bridges");
      await writeFile(blocker, "not a directory");
      ctx.model.provider = "antigravity";
      try {
        await run("on");
        assert.ok(
          notices.some((notice) =>
            /failed to switch tools; mode remains native/.test(notice.message),
          ),
        );
        assert.match(await status(), /OFF \(native\)/);
        assert.equal(savedMode(), "native");
        assert.equal(footer.get("antigravity"), "pi-tools:off");
        assert.equal(branch[0], history);
      } finally {
        await rm(blocker, { force: true });
        ctx.model.provider = "other";
      }
    },
  );

  await t.test(
    "a failed settings write restores the running mode and preserves the file",
    async () => {
      await writeFile(settingsFile, "{broken");
      try {
        await run("on");
        assert.match(notices.at(-1)!.message, /failed to switch tools; mode remains native/);
        assert.match(await status(), /OFF \(native\)/);
        assert.throws(savedMode);
      } finally {
        await writeFile(settingsFile, '{"antigravity":{"toolMode":"native"}}');
      }
    },
  );

  await t.test("agy tools saves both modes across replacement extension runtimes", async () => {
    const reload = async () => {
      await handlers.get("session_shutdown")!({}, {});
      assert.equal(footer.get("antigravity"), undefined);
      handlers.clear();
      commands.clear();
      extension(pi as never);
      await handlers.get("session_start")!({ reason: "resume" }, ctx);
    };
    ctx.model.provider = "antigravity";
    await commands.get("agy")!.handler("tools on", ctx as never);
    assert.equal(savedMode(), "pi");
    assert.equal(footer.get("antigravity"), "pi-tools:on");
    await reload();
    assert.match(await status(), /ON \(pi\)/);
    assert.equal(footer.get("antigravity"), "pi-tools:on");
    await commands.get("agy")!.handler("tools off", ctx as never);
    assert.equal(savedMode(), "native");
    assert.equal(footer.get("antigravity"), "pi-tools:off");
    await reload();
    assert.match(await status(), /OFF \(native\)/);
    assert.equal(footer.get("antigravity"), "pi-tools:off");
    ctx.model.provider = "other";
    await handlers.get("model_select")!({ model: ctx.model }, ctx);
    assert.equal(footer.get("antigravity"), undefined);
    assert.equal(branch[0], history);
  });
});
