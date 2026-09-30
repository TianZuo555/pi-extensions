import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PiToolInfo } from "../lib/bridge.ts";

// Drive the entry hooks without touching the real profile or spawning agy.
test("entry warns about the MCP adapter only when Antigravity is selected, once per session", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "agy-adapter-warning-"));
  const env = {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: "",
    HOMEPATH: home,
    PI_CODING_AGENT_DIR: path.join(home, "pi-agent"),
    PI_ANTIGRAVITY_PI_TOOL_BRIDGE: "1",
    AGY_BINARY: path.join(home, "missing-agy"),
  };
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });
  Object.assign(process.env, env);
  assert.equal(path.resolve(homedir()), path.resolve(home));
  const cacheDir = path.join(home, ".pi/antigravity");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    path.join(cacheDir, "model-list.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      source: "live",
      models: [
        {
          id: "gemini-3.7-flash",
          name: "Gemini 3.7 Flash",
          supportedEfforts: ["high"],
          defaultEffort: "high",
        },
      ],
    }),
  );
  // index.ts binds its cache path and bridge flag at import time.
  const { default: antigravityExtension } = await import("../index.ts");
  const adapter = { source: "npm:pi-mcp-adapter" };
  const builtin = { source: "builtin", path: "builtin:mcp" };
  const cases: Array<{
    name: string;
    provider: string;
    tools: PiToolInfo[];
    commands: PiToolInfo[];
    expected: number;
  }> = [
    {
      name: "inactive adapter tools warn at session startup",
      provider: "antigravity",
      tools: [{ name: "mcp", sourceInfo: adapter }],
      commands: [],
      expected: 1,
    },
    {
      name: "adapter command warns on model switch even without server tools",
      provider: "pi",
      tools: [],
      commands: [{ name: "mcp", sourceInfo: adapter }],
      expected: 1,
    },
    {
      name: "built-in MCP does not warn",
      provider: "antigravity",
      tools: [{ name: "mcp__docs__search", sourceInfo: builtin }],
      commands: [{ name: "mcp", sourceInfo: builtin }],
      expected: 0,
    },
    {
      name: "MCP tool and command names alone do not warn",
      provider: "antigravity",
      tools: [{ name: "mcp", sourceInfo: { source: "npm:other-extension" } }],
      commands: [{ name: "mcp", sourceInfo: { source: "npm:other-extension" } }],
      expected: 0,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      const notifications: Array<{ message: string; type: string }> = [];
      const pi = {
        on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          handlers.set(name, handler);
        },
        registerCommand: () => {},
        registerEntryRenderer: () => {},
        registerProvider: () => {},
        registerTool: () => {},
        appendEntry: () => {},
        getActiveTools: () => [],
        getAllTools: () => scenario.tools,
        getCommands: () => scenario.commands,
        setActiveTools: () => {},
      };
      antigravityExtension(pi as never);
      t.after(async () => {
        await handlers.get("session_shutdown")!({}, {});
      });
      const ctx = {
        cwd: home,
        hasUI: true,
        model: { provider: scenario.provider, id: "gemini-3.7-flash" },
        ui: {
          notify: (message: string, type: string) => notifications.push({ message, type }),
          setWidget: () => {},
        },
        sessionManager: { getBranch: () => [], getSessionId: () => scenario.name },
      };
      const adapterWarnings = () =>
        notifications.filter(({ message }) => message.includes("pi-mcp-adapter is installed"));
      await handlers.get("session_start")!({ reason: "new" }, ctx);
      assert.equal(
        adapterWarnings().length,
        scenario.provider === "antigravity" ? scenario.expected : 0,
      );
      ctx.model.provider = "antigravity";
      for (let i = 0; i < 2; i++) {
        await handlers.get("model_select")!({ model: ctx.model }, ctx);
      }
      assert.equal(adapterWarnings().length, scenario.expected);
      if (scenario.expected) {
        assert.equal(adapterWarnings()[0].type, "warning");
        assert.match(adapterWarnings()[0].message, /mcp\.json/);
      }
    });
  }
});
