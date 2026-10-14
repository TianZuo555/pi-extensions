import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import usageExtension from "../index.ts";

const USAGE = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 25, reset_at: 1_800_000_000 },
    secondary_window: { used_percent: 40, reset_at: 1_800_500_000 },
  },
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(t: test.TestContext, legacy: "fresh" | "expired" | "none" = "fresh") {
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_COPILOT_TOKEN",
    "COPILOT_GITHUB_TOKEN",
    "ZAI_API_KEY",
    "ZAI_CODING_CN_API_KEY",
    "ZHIPU_API_KEY",
    "DEEPSEEK_API_KEY",
    "MIMO_API_KEY",
    "MIMO_COOKIE",
  ]) {
    const value = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
  const auth = {
    openai: { type: "oauth", access: "modern-token", accountId: "different-account" },
    ...(legacy === "none"
      ? {}
      : {
          "openai-codex": {
            type: "oauth",
            access: "legacy-token",
            accountId: "legacy-account",
            refresh: "legacy-refresh",
            expires: legacy === "expired" ? 0 : Date.now() + 3_600_000,
          },
        }),
  };
  const authFile = path.join(getAgentDir(), "auth.json");
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const file = String(args[0]);
    if (file === authFile) return JSON.stringify(auth);
    if (file.endsWith(path.join("github-copilot", "apps.json"))) return "{}";
    return readFileSync(...args);
  });
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, _init?: RequestInit) => Response.json(USAGE),
  );
  const events = new Map<string, (event: unknown, ctx: any) => void | Promise<void>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  usageExtension({
    on: (name: string, handler: any) => events.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as any);
  const statuses: (string | undefined)[] = [];
  const messages: string[] = [];
  const menus: string[] = [];
  const refreshes: string[] = [];
  let changed = deferred<void>();
  const ctx = {
    model: { provider: "openai" },
    mode: "rpc",
    hasUI: true,
    modelRegistry: {
      getProviderAuthStatus: (provider: string) => ({
        configured: provider === "openai" || (legacy !== "none" && provider === "openai-codex"),
      }),
      getProviderAuth: async (provider: string) => {
        refreshes.push(provider);
        assert.equal(provider, "openai-codex");
        return { auth: { apiKey: "refreshed-legacy-token" } };
      },
    },
    ui: {
      setStatus: (_key: string, value: string | undefined) => {
        statuses.push(value);
        changed.resolve();
      },
      notify: (message: string) => messages.push(message),
      select: async (title: string) => {
        menus.push(title);
        return "Close";
      },
    },
  };
  t.after(async () => events.get("session_shutdown")!({}, ctx));
  return {
    ctx,
    fetch,
    statuses,
    messages,
    menus,
    refreshes,
    commands,
    emit: (name: string) => events.get(name)!({}, ctx),
    nextStatus: () => {
      changed = deferred<void>();
      return changed.promise;
    },
  };
}

for (const event of ["session_start", "model_select", "turn_start"]) {
  test(`OpenAI ${event} queries legacy Codex and publishes its footer meter`, {
    timeout: 5000,
  }, async (t) => {
    const h = setup(t);
    const published = h.nextStatus();
    h.emit(event);
    await published;
    assert.match(h.statuses.at(-1)!, /codex 75% 5h 60% wk/);
    assert.equal(h.fetch.mock.callCount(), 1);
    const [url, init] = h.fetch.mock.calls[0]!.arguments;
    assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer legacy-token");
    assert.deepEqual(h.refreshes, []);
  });
}

test("OpenAI models refresh expired legacy credentials using the Codex provider", {
  timeout: 5000,
}, async (t) => {
  const h = setup(t, "expired");
  const published = h.nextStatus();
  h.emit("session_start");
  await published;
  assert.deepEqual(h.refreshes, ["openai-codex"]);
  const [, init] = h.fetch.mock.calls[0]!.arguments;
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer refreshed-legacy-token");
  assert.match(h.statuses.at(-1)!, /codex 75% 5h 60% wk/);
});

for (const hasUI of [true, false]) {
  test(`missing legacy login shows guidance without using the modern token (hasUI=${hasUI})`, {
    timeout: 5000,
  }, async (t) => {
    const h = setup(t, "none");
    h.ctx.hasUI = hasUI;
    const published = h.nextStatus();
    h.emit("session_start");
    await published;
    assert.match(h.statuses.at(-1)!, /\/login → OpenAI Codex \(legacy\)/);
    await h.commands.get("usage")!.handler("", h.ctx);
    assert.match(h.messages[0]!, /\/login → OpenAI Codex \(legacy\)/);
    assert.equal(h.fetch.mock.callCount(), 0);
    assert.deepEqual(h.refreshes, []);
  });
}

test("/usage and Refresh publish legacy Codex usage for an OpenAI model", async (t) => {
  const h = setup(t);
  h.ctx.ui.select = async (title: string) => {
    h.menus.push(title);
    return h.menus.length === 1 ? "Refresh" : "Close";
  };
  await h.commands.get("usage")!.handler("", h.ctx);
  assert.equal(h.menus.length, 2);
  assert.equal(h.fetch.mock.callCount(), 2);
  assert.ok(h.statuses.every((status) => status?.includes("codex 75% 5h 60% wk")));
});

test("OpenAI and Codex model switches reuse one cached report", { timeout: 5000 }, async (t) => {
  const h = setup(t);
  for (const provider of ["openai", "openai-codex", "openai"]) {
    h.ctx.model.provider = provider;
    const published = h.nextStatus();
    h.emit("model_select");
    await published;
    assert.match(h.statuses.at(-1)!, /codex 75% 5h 60% wk/);
  }
  assert.equal(h.fetch.mock.callCount(), 1);
  h.ctx.model.provider = "anthropic";
  h.emit("model_select");
  assert.equal(h.statuses.at(-1), undefined);
});

test("Codex query failures leave the OpenAI footer empty", { timeout: 5000 }, async (t) => {
  const h = setup(t);
  h.fetch.mock.mockImplementation(async () => Response.json({}, { status: 401 }));
  const published = h.nextStatus();
  h.emit("session_start");
  await published;
  assert.equal(h.statuses.at(-1), undefined);
});

test("switching to an unsupported model prevents a pending Codex report from publishing", {
  timeout: 5000,
}, async (t) => {
  const h = setup(t);
  const started = deferred<void>();
  const response = deferred<Response>();
  h.fetch.mock.mockImplementation(async () => {
    started.resolve();
    return response.promise;
  });
  h.emit("model_select");
  await started.promise;
  h.ctx.model.provider = "anthropic";
  h.emit("model_select");
  response.resolve(Response.json(USAGE));
  await h.commands.get("usage")!.handler("", h.ctx);
  assert.ok(h.statuses.every((status) => status === undefined));
});
